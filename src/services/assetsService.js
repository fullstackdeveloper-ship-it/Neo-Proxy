/**
 * Assets Service
 * Serves local assets and rewrites paths based on session/site
 */

const fs = require('fs');
const path = require('path');
const { getSiteFromSession } = require('./sessionManager');

const ASSETS_DIR = path.join(__dirname, '../assets');
const JS_FILE = 'main.e1802fd1.js';
const CSS_FILE = 'main.959413d2.css';

// Cache for rewritten assets (sessionId -> { js: content, css: content })
const assetCache = new Map();

/**
 * Rewrite asset paths based on site
 */
function rewriteAssetContent(content, siteName, fileType) {
  const sitePrefix = `/vpn/${siteName}/neocore`;
  
  if (fileType === 'js') {
    // Rewrite API calls, static paths, etc.
    content = content
      // API endpoints
      .replace(/["'](\/api\/[^"']+)["']/g, `"${sitePrefix}$1"`)
      // Static assets
      .replace(/["'](\/static\/[^"']+)["']/g, `"${sitePrefix}$1"`)
      // Fetch/Axios calls
      .replace(/(fetch|axios|XMLHttpRequest)\(["'](\/[^"']+)["']/g, (match, method, urlPath) => {
        if (urlPath.startsWith('/api/') || urlPath.startsWith('/static/')) {
          return `${method}("${sitePrefix}${urlPath}")`;
        }
        return match;
      })
      // URL objects
      .replace(/url:\s*["'](\/[^"']+)["']/g, (match, urlPath) => {
        if (urlPath.startsWith('/api/') || urlPath.startsWith('/static/')) {
          return `url: "${sitePrefix}${urlPath}"`;
        }
        return match;
      })
      // Root assets (images, etc.)
      .replace(/["'](\/([^"?#\/]+\.(png|svg|ico|jpg|jpeg|webp|gif|woff|woff2|ttf|eot|otf)))(\?[^"]*)?["']/g, 
        `"${sitePrefix}$1$4"`);
  } else if (fileType === 'css') {
    // Rewrite CSS URLs
    content = content
      .replace(/url\(["']?(\/[^"')]+)["']?\)/g, (match, urlPath) => {
        // Skip if already has /vpn/ prefix or external URL
        if (urlPath.startsWith('/vpn/') || urlPath.startsWith('http')) {
          return match;
        }
        return `url("${sitePrefix}${urlPath}")`;
      });
  }
  
  return content;
}

/**
 * Get asset content (with caching)
 */
function getAsset(sessionId, fileName) {
  // Get site from session
  const siteName = getSiteFromSession(sessionId);
  if (!siteName) {
    throw new Error('Invalid or expired session');
  }
  
  // Check cache
  const cacheKey = `${sessionId}:${fileName}`;
  if (assetCache.has(cacheKey)) {
    return assetCache.get(cacheKey);
  }
  
  // Read file
  const filePath = path.join(ASSETS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Asset not found: ${fileName}`);
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  const fileType = fileName.endsWith('.js') ? 'js' : 'css';
  
  // Rewrite paths based on site
  content = rewriteAssetContent(content, siteName, fileType);
  
  // Cache (with size limit - optional)
  if (assetCache.size < 100) { // Limit cache to 100 entries
    assetCache.set(cacheKey, content);
  }
  
  return content;
}

/**
 * Serve asset file
 */
function serveAsset(req, res, sessionId) {
  try {
    const url = req.url;
    let fileName, contentType;
    
    // Determine file from URL
    if (url.includes(JS_FILE) || url.endsWith('.js')) {
      fileName = JS_FILE;
      contentType = 'application/javascript';
    } else if (url.includes(CSS_FILE) || url.endsWith('.css')) {
      fileName = CSS_FILE;
      contentType = 'text/css';
    } else {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    const content = getAsset(sessionId, fileName);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Served-From', 'local-assets');
    res.send(content);
    
    console.log(`📦 Served asset: ${fileName} for session ${sessionId.substring(0, 8)}...`);
  } catch (err) {
    console.error(`❌ Error serving asset:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

/**
 * Clear cache for a session (optional)
 */
function clearCacheForSession(sessionId) {
  for (const key of assetCache.keys()) {
    if (key.startsWith(sessionId)) {
      assetCache.delete(key);
    }
  }
}

module.exports = {
  serveAsset,
  getAsset,
  clearCacheForSession
};
