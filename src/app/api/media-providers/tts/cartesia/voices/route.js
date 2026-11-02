import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { fetchCartesiaVoices, fetchCartesiaAccents } from "open-sse/handlers/ttsCore.js";
import { CARTESIA_SUPPORTED_LANGUAGES } from "open-sse/handlers/ttsProviders/cartesia.js";

const langNames = new Intl.DisplayNames(["en"], { type: "language" });

/**
 * GET /api/media-providers/tts/cartesia/voices[?lang=en][&apiKey=...]
 * Returns { languages, byLang } grouped by language.
 * Fetches accents from https://api.cartesia.ai/accents for full official language/accent support.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const langFilter = searchParams.get("lang");
    const queryApiKey = searchParams.get("apiKey");

    let apiKey = queryApiKey;
    if (!apiKey) {
      const connections = await getProviderConnections({ provider: "cartesia", isActive: true });
      apiKey = connections[0]?.apiKey;
    }
    if (!apiKey) {
      return NextResponse.json({ error: "No Cartesia connection found" }, { status: 400 });
    }

    const [voices, accents] = await Promise.all([
      fetchCartesiaVoices(apiKey).catch(() => []),
      fetchCartesiaAccents(apiKey).catch(() => []),
    ]);

    // Build unique language codes from accents + fallback supported languages
    const langCodeSet = new Set();
    const accentNamesByLang = {};

    for (const a of accents) {
      if (a?.language) {
        langCodeSet.add(a.language);
        if (!accentNamesByLang[a.language] && a.name) {
          accentNamesByLang[a.language] = a.name;
        }
      }
    }

    // Ensure all supported languages are present
    for (const code of CARTESIA_SUPPORTED_LANGUAGES) {
      langCodeSet.add(code);
    }

    // Also include languages from any custom voices
    for (const v of voices) {
      if (v.lang) langCodeSet.add(v.lang);
      if (Array.isArray(v.locales)) {
        for (const loc of v.locales) {
          const locCode = (loc.locale || "").split("-")[0];
          if (locCode) langCodeSet.add(locCode);
        }
      }
    }

    const byLang = {};

    for (const code of langCodeSet) {
      let displayName = "";
      try {
        displayName = langNames.of(code);
      } catch {
        displayName = accentNamesByLang[code] || code;
      }
      if (!displayName) displayName = code;

      // Group voices for this language:
      // 1. Voices that specifically target this language/locale
      // 2. Multilingual Sonic voices (all available library voices)
      const matchingVoices = [];
      const otherVoices = [];

      for (const v of voices) {
        const isDirectMatch = v.lang === code || (Array.isArray(v.locales) && v.locales.some((l) => (l.locale || "").startsWith(code)));
        const item = {
          id: v.id,
          name: v.name,
          gender: v.gender || "",
          lang: code,
          description: v.description || "",
          is_owner: v.is_owner,
        };
        if (isDirectMatch) {
          matchingVoices.push(item);
        } else {
          otherVoices.push(item);
        }
      }

      byLang[code] = {
        code,
        name: displayName,
        voices: [...matchingVoices, ...otherVoices],
      };
    }

    const languages = Object.values(byLang).sort((a, b) => a.name.localeCompare(b.name));

    if (langFilter) {
      return NextResponse.json({ voices: byLang[langFilter]?.voices || [] });
    }

    return NextResponse.json({ languages, byLang });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Failed to fetch voices" }, { status: 502 });
  }
}
