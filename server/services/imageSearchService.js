import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Fetch product image URL(s) or local files from search engines using keyword.
 * @param {string} keyword - Product name or query.
 * @param {string} [outputDir] - Optional directory to save image files locally.
 * @returns {Promise<string[]>} Array of image URLs or local image file paths.
 */
export async function fetchProductImageFromSearch(keyword, outputDir = null) {
  if (!keyword || typeof keyword !== 'string') return [];

  const cleanKeyword = keyword.trim();
  console.log(`[ImageSearch] Searching product image for keyword: "${cleanKeyword}"`);

  let imageUrls = [];

  // Method 1: DuckDuckGo API Search
  try {
    const vdqUrl = `https://duckduckgo.com/i.js?q=${encodeURIComponent(cleanKeyword)}&o=json`;
    const response = await axios.get(vdqUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 7000
    });

    if (response.data && Array.isArray(response.data.results)) {
      imageUrls = response.data.results
        .slice(0, 3)
        .map(item => item.image || item.thumbnail)
        .filter(Boolean);
    }
  } catch (err) {
    console.warn(`[ImageSearch] DuckDuckGo API search failed: ${err.message}`);
  }

  // Method 2: Fallback HTML Scraping
  if (imageUrls.length === 0) {
    try {
      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanKeyword + ' product image')}`;
      const response = await axios.get(htmlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 7000
      });

      const imgRegex = /<img[^>]+src=["'](https?:\/\/[^"'\s]+)["']/gi;
      let match;
      while ((match = imgRegex.exec(response.data)) !== null && imageUrls.length < 3) {
        const url = match[1];
        if (!url.includes('duckduckgo.com/assets') && !url.includes('icon')) {
          imageUrls.push(url);
        }
      }
    } catch (err) {
      console.warn(`[ImageSearch] DuckDuckGo HTML scraping failed: ${err.message}`);
    }
  }

  // Method 3: Download locally if outputDir is provided
  if (outputDir && imageUrls.length > 0) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const downloadedPaths = [];
    for (let i = 0; i < imageUrls.length; i++) {
      try {
        let imgUrl = imageUrls[i];
        if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
        
        const destPath = path.join(outputDir, `product_search_${i}_${Date.now()}.jpg`);
        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 5000 });
        fs.writeFileSync(destPath, imgRes.data);
        downloadedPaths.push(destPath);
      } catch (dlErr) {
        console.warn(`[ImageSearch] Download failed for image ${i}: ${dlErr.message}`);
      }
    }

    if (downloadedPaths.length > 0) {
      return downloadedPaths;
    }
  }

  return imageUrls;
}
