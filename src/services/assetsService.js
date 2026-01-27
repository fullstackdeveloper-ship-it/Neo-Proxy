/**
 * Assets Service
 * Serves local assets and rewrites paths based on site detection from request
 */

const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '../build');
const ASSETS_DIR = path.join(BUILD_DIR, 'static');
const JS_FILE = 'js/main.e1802fd1.js';
const CSS_FILE = 'css/main.959413d2.css';

// Cache for rewritten assets (siteName -> { js: content, css: content })
const assetCache = new Map();

/**
 * Rewrite asset paths based on site
 */
function rewriteAssetContent(content, siteName, fileType) {
  const sitePrefix = `/vpn/${siteName}/neocore`;
  
  if (fileType === 'js') {
    // Rewrite API calls, static paths, etc.
    content = content
      // 1. BASE_URL constant: BASE_URL: "/api" -> BASE_URL: "/vpn/{site}/neocore/api"
      .replace(/(BASE_URL|baseURL|baseUrl|base_url)\s*:\s*["'](\/api)["']/gi, 
        `$1: "${sitePrefix}$2"`)
      
      // 2. this.request method: "".concat("/api").concat(e) -> "".concat("/vpn/{site}/neocore/api").concat(e)
      .replace(/(""\.concat\(")(\/api)("\)\.concat\()/g, 
        (match, prefix, apiPath, suffix) => {
          return prefix + sitePrefix + apiPath + suffix;
        })
      
      // 3. fetch with concat: fetch("".concat("/api", "/path")) -> fetch("".concat("/vpn/{site}/neocore/api", "/path"))
      .replace(/(fetch|axios|XMLHttpRequest)\(["']\.concat\(["'](\/api)(["'],\s*["'])/g, 
        (match, method, apiPath, rest) => {
          return method + '("".concat("' + sitePrefix + apiPath + '"' + rest;
        })
      
      // 4. Direct API endpoints in strings: "/api/health" -> "/vpn/{site}/neocore/api/health"
      .replace(/["'](\/api\/[^"']+)["']/g, `"${sitePrefix}$1"`)
      
      // 5. Static assets: "/static/js/main.js" -> "/vpn/{site}/neocore/static/js/main.js"
      .replace(/["'](\/static\/[^"']+)["']/g, `"${sitePrefix}$1"`)
      
      // 6. Fetch/Axios calls with direct paths
      .replace(/(fetch|axios|XMLHttpRequest)\(["'](\/[^"']+)["']/g, (match, method, urlPath) => {
        if (urlPath.startsWith('/api/') || urlPath.startsWith('/static/')) {
          return `${method}("${sitePrefix}${urlPath}")`;
        }
        return match;
      })
      
      // 7. URL objects in config
      .replace(/url:\s*["'](\/[^"']+)["']/g, (match, urlPath) => {
        if (urlPath.startsWith('/api/') || urlPath.startsWith('/static/')) {
          return `url: "${sitePrefix}${urlPath}"`;
        }
        return match;
      })
      
      // 8. Root assets (images, fonts, etc.)
      .replace(/["'](\/([^"?#\/]+\.(png|svg|ico|jpg|jpeg|webp|gif|woff|woff2|ttf|eot|otf)))(\?[^"]*)?["']/g, 
        (match, path, filename, ext, query) => {
          // Skip if already has /vpn/ prefix
          if (path.startsWith('/vpn/')) return match;
          return `"${sitePrefix}${path}${query || ''}"`;
        });
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
 * Detect site from request (referer or URL)
 */
function detectSiteFromRequest(req, allSites) {
  // Try to get site from referer
  const referer = req.headers.referer || req.headers.origin || '';
  const siteMatch = referer.match(/\/vpn\/([^\/]+)\//);
  
  if (siteMatch) {
    const siteName = siteMatch[1];
    if (allSites[siteName] && allSites[siteName].neocore?.enabled) {
      return siteName;
    }
  }
  
  // Try to get from URL if direct request
  const urlMatch = req.url.match(/\/vpn\/([^\/]+)\//);
  if (urlMatch) {
    const siteName = urlMatch[1];
    if (allSites[siteName] && allSites[siteName].neocore?.enabled) {
      return siteName;
    }
  }
  
  return null;
}

/**
 * Get asset content (with caching per site)
 */
function getAsset(siteName, fileName) {
  if (!siteName) {
    throw new Error('Site not detected from request');
  }
  
  // Check cache
  const cacheKey = `${siteName}:${fileName}`;
  if (assetCache.has(cacheKey)) {
    return assetCache.get(cacheKey);
  }
  
  // Read file from build/static directory
  const fileType = fileName.endsWith('.js') ? 'js' : 'css';
  const filePath = fileType === 'js' 
    ? path.join(ASSETS_DIR, JS_FILE)
    : path.join(ASSETS_DIR, CSS_FILE);
    
  if (!fs.existsSync(filePath)) {
    throw new Error(`Asset not found: ${filePath}`);
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Rewrite paths based on site
  content = rewriteAssetContent(content, siteName, fileType);
  
  // Cache (with size limit - optional)
  if (assetCache.size < 200) { // Limit cache to 200 entries
    assetCache.set(cacheKey, content);
  }
  
  return content;
}

/**
 * Serve asset file
 */
function serveAsset(req, res, allSites) {
  try {
    // Detect site from request
    const siteName = detectSiteFromRequest(req, allSites);
    if (!siteName) {
      return res.status(400).json({ 
        error: 'Site not detected',
        message: 'Please access through /vpn/{site}/neocore first'
      });
    }
    
    const url = req.url;
    let fileName, contentType;
    
    // Determine file from URL (handle both /main.*.js and /static/js/main.*.js)
    if (url.includes('main.') && url.endsWith('.js')) {
      fileName = 'main.e1802fd1.js';
      contentType = 'application/javascript';
    } else if (url.includes('main.') && url.endsWith('.css')) {
      fileName = 'main.959413d2.css';
      contentType = 'text/css';
    } else {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    const content = getAsset(siteName, fileName);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Served-From', 'local-build');
    res.send(content);
    
    console.log(`📦 Served asset: ${fileName} for site: ${siteName}`);
  } catch (err) {
    console.error(`❌ Error serving asset:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

/**
 * Serve HTML from build directory
 */
function serveHTML(req, res, siteName) {
  try {
    const htmlPath = path.join(BUILD_DIR, 'index.html');
    
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).json({ error: 'Frontend build not found' });
    }
    
    let html = fs.readFileSync(htmlPath, 'utf8');
    const sitePrefix = `/vpn/${siteName}/neocore`;
    
    // Rewrite asset paths in HTML
    html = html
      // Rewrite JS: /static/js/main.js -> /main.e1802fd1.js (local asset)
      .replace(/src="\/static\/js\/(main\.[^"]+\.js)"/g, 
        `src="/$1"`)
      // Rewrite CSS: /static/css/main.css -> /main.959413d2.css (local asset)
      .replace(/href="\/static\/css\/(main\.[^"]+\.css)"/g, 
        `href="/$1"`)
      // Rewrite other assets (images, icons) to use site prefix for backend
      .replace(/(src|href)="\/([^"]+\.(png|svg|ico|jpg|jpeg|webp|gif))"/g, 
        `$1="${sitePrefix}/$2"`);
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    
    console.log(`📄 Served HTML for site: ${siteName}`);
  } catch (err) {
    console.error(`❌ Error serving HTML:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

/**
 * Clear cache for a site (optional)
 */
function clearCacheForSite(siteName) {
  for (const key of assetCache.keys()) {
    if (key.startsWith(siteName + ':')) {
      assetCache.delete(key);
    }
  }
}

module.exports = {
  serveAsset,
  serveHTML,
  getAsset,
  detectSiteFromRequest,
  clearCacheForSite
};
