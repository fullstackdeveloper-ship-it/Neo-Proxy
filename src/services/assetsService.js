/**
 * Assets Service
 * Simple file serving - no rewriting needed
 */

const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '../build');
const ASSETS_DIR = path.join(BUILD_DIR, 'static');
const JS_FILE = 'js/main.e1802fd1.js';
const CSS_FILE = 'css/main.959413d2.css';

/**
 * Serve asset file (as-is, no rewriting)
 */
function serveAsset(req, res) {
  try {
    const url = req.url;
    let filePath, contentType;
    
    // Determine file from URL
    if (url.includes('main.') && url.endsWith('.js')) {
      filePath = path.join(ASSETS_DIR, JS_FILE);
      contentType = 'application/javascript';
    } else if (url.includes('main.') && url.endsWith('.css')) {
      filePath = path.join(ASSETS_DIR, CSS_FILE);
      contentType = 'text/css';
    } else {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Asset file not found' });
    }
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath);
    
    console.log(`📦 Served asset: ${path.basename(filePath)}`);
  } catch (err) {
    console.error(`❌ Error serving asset:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

/**
 * Serve HTML from build directory with base tag injection for React Router
 */
function serveHTML(req, res, siteName) {
  try {
    const htmlPath = path.join(BUILD_DIR, 'index.html');
    
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).json({ error: 'Frontend build not found' });
    }
    
    // Read HTML file
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // Inject base tag if siteName is provided
    if (siteName) {
      const basePath = `/vpn/${siteName}/neocore`;
      
      // Check if base tag already exists
      if (!html.includes('<base')) {
        // Inject base tag right after <head>
        html = html.replace('<head>', `<head>\n<base href="${basePath}/">`);
      } else {
        // Replace existing base tag
        html = html.replace(/<base[^>]*>/, `<base href="${basePath}/">`);
      }
    }
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    
    console.log(`📄 Served HTML${siteName ? ` (site: ${siteName})` : ''}`);
  } catch (err) {
    console.error(`❌ Error serving HTML:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

module.exports = {
  serveAsset,
  serveHTML
};
