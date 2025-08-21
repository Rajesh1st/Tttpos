// server.js
// Express API that auto-detects Movie vs TV via TMDb multi search
// and returns grouped image URLs. Ready for Render deployment.

import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const TMDB_API_KEY = process.env.TMDB_API_KEY; // set this on Render
const BASE_URL = "https://api.themoviedb.org/3";
const IMG_URL = "https://image.tmdb.org/t/p/original";

// Simple health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tmdb-images-api", message: "Up & running" });
});

// GET /images?query=Marry%20My%20Husband
app.get("/images", async (req, res) => {
  const query = (req.query.query || "").toString().trim();
  if (!TMDB_API_KEY) {
    return res
      .status(500)
      .json({ error: "TMDB_API_KEY missing in environment variables" });
  }
  if (!query) {
    return res.status(400).json({ error: "query param is required" });
  }

  try {
    // 1) multi search
    const multi = await axios.get(`${BASE_URL}/search/multi`, {
      params: { api_key: TMDB_API_KEY, query },
    });

    const results = Array.isArray(multi.data?.results) ? multi.data.results : [];

    // pick the first non-person result (movie or tv)
    const first =
      results.find((r) => r.media_type === "movie" || r.media_type === "tv") ||
      results[0];

    if (!first) {
      return res.status(404).json({ error: "No result found" });
    }

    const media_type = first.media_type; // 'movie' | 'tv' | 'person' (rare)
    if (media_type !== "movie" && media_type !== "tv") {
      return res.status(404).json({
        error:
          "Top result is not a movie/tv. Try a more specific query (person results are skipped).",
      });
    }

    const item_id = first.id;
    const title = first.title || first.name || "Unknown";

    // 2) fetch images for detected type
    const imagesResp = await axios.get(`${BASE_URL}/${media_type}/${item_id}/images`, {
      params: {
        api_key: TMDB_API_KEY,
        include_image_language: "en,hi,ta,te,ja,ko,null",
      },
    });

    const images = imagesResp.data || {};

    // helpers
    const asFull = (arr = []) => arr.map((i) => IMG_URL + i.file_path);

    // backdrops: we only expose selected languages + "null" (language-agnostic)
    const backdropLangs = ["en", "hi", null]; // null handled specially
    const groupedBackdrops = { en: [], hi: [], null: [] };
    (images.backdrops || []).forEach((b) => {
      const lang = b.iso_639_1 === null ? "null" : b.iso_639_1;
      if (backdropLangs.includes(b.iso_639_1) || lang === "null") {
        groupedBackdrops[lang].push(IMG_URL + b.file_path);
      }
    });

    // posters: expose common langs you listed
    const posterLangs = ["en", "hi", "ta", "te", "ja", "ko"];
    const groupedPosters = Object.fromEntries(posterLangs.map((l) => [l, []]));
    (images.posters || []).forEach((p) => {
      const lang = p.iso_639_1;
      if (posterLangs.includes(lang)) {
        groupedPosters[lang].push(IMG_URL + p.file_path);
      }
    });

    // logos: group ALL languages (including null)
    const groupedLogos = {};
    (images.logos || []).forEach((l) => {
      const lang = l.iso_639_1 === null ? "null" : l.iso_639_1;
      if (!groupedLogos[lang]) groupedLogos[lang] = [];
      groupedLogos[lang].push(IMG_URL + l.file_path);
    });

    // optional "skipped" like your Python
    const skipped = [];
    if (
      !groupedBackdrops.en.length &&
      !groupedBackdrops.hi.length &&
      !groupedBackdrops.null.length
    ) {
      skipped.push("Backdrops (en/hi/null)");
    }
    const posterSectionsSkipped = posterLangs.filter((l) => groupedPosters[l].length === 0);
    if (posterSectionsSkipped.length) {
      skipped.push(
        `Posters (${posterSectionsSkipped.join(", ")})`
      );
    }
    if (!Object.keys(groupedLogos).length) {
      skipped.push("Logos (All Languages)");
    }

    // formatted text block (if you want to show like your example)
    let formatted = `🎬 Results for ${title} (${media_type.toUpperCase()})\n\n`;

    const backTitleMap = {
      en: "🇺🇸 English Landscape",
      hi: "🇮🇳 Hindi Landscape",
      null: "🌐 Clean Landscape",
    };
    for (const k of ["en", "hi", "null"]) {
      const list = groupedBackdrops[k];
      if (list?.length) {
        formatted += `${backTitleMap[k]}\n`;
        list.forEach((url, i) => (formatted += `${i + 1}. ${url}\n`));
        formatted += `\n`;
      }
    }

    const posterTitleMap = {
      en: "🇺🇸 English Posters",
      hi: "🇮🇳 Hindi Posters",
      ta: "🇮🇳 Tamil Posters",
      te: "🇮🇳 Telugu Posters",
      ja: "🇯🇵 Japanese Posters",
      ko: "🇰🇷 Korean Posters",
    };
    for (const k of posterLangs) {
      const list = groupedPosters[k];
      if (list?.length) {
        formatted += `${posterTitleMap[k]}\n`;
        list.forEach((url, i) => (formatted += `${i + 1}. ${url}\n`));
        formatted += `\n`;
      }
    }

    if (Object.keys(groupedLogos).length) {
      formatted += `🎯 Logos (All Languages)\n`;
      for (const [lang, urls] of Object.entries(groupedLogos)) {
        const label = lang === "null" ? "🌐 No Language" : `🌐 ${lang.toUpperCase()}`;
        formatted += `${label}\n`;
        urls.forEach((url, i) => (formatted += `${i + 1}. ${url}\n`));
        formatted += `\n`;
      }
    }

    if (skipped.length) {
      formatted += `⚠️ Skipped:\n`;
      skipped.forEach((s) => (formatted += `- ${s}\n`));
      formatted += `\n`;
    }

    return res.json({
      query,
      detected: { media_type, id: item_id, title },
      backdrops: groupedBackdrops,
      posters: groupedPosters,
      logos: groupedLogos,
      skipped,
      formatted, // handy if you want a ready-to-print text block
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    return res.status(500).json({
      error: "Error fetching data",
      details: err?.response?.data || err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`tmdb-images-api listening on port ${PORT}`);
});
