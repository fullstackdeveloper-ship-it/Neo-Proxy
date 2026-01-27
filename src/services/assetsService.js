/**
 * Assets Service - Serves static files and HTML
 */

const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '../build');
const ASSETS_DIR = path.join(BUILD_DIR, 'static');

/**
 * Find main JS and CSS files dynamically
 */
function findAssetFiles() {
  const jsDir = path.join(ASSETS_DIR, 'js');
  const cssDir = path.join(ASSETS_DIR, 'css');
  
  let jsFile = null, cssFile = null;
  
  if (fs.existsSync(jsDir)) {
    const files = fs.readdirSync(jsDir).filter(f => f.startsWith('main.') && f.endsWith('.js'));
    if (files.length > 0) jsFile = `js/${files[0]}`;
  }
  
  if (fs.existsSync(cssDir)) {
    const files = fs.readdirSync(cssDir).filter(f => f.startsWith('main.') && f.endsWith('.css'));
    if (files.length > 0) cssFile = `css/${files[0]}`;
  }
  
  return { jsFile, cssFile };
}

/**
 * Serve asset file
 */
function serveAsset(req, res) {
  try {
    const { jsFile, cssFile } = findAssetFiles();
    const url = req.url;
    let filePath, contentType;
    
    if (url.includes('main.') && url.endsWith('.js')) {
      if (!jsFile) return res.status(404).json({ error: 'JS file not found' });
      filePath = path.join(ASSETS_DIR, jsFile);
      contentType = 'application/javascript';
    } else if (url.includes('main.') && url.endsWith('.css')) {
      if (!cssFile) return res.status(404).json({ error: 'CSS file not found' });
      filePath = path.join(ASSETS_DIR, cssFile);
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
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

/**
 * Serve HTML with base tag injection
 */
function serveHTML(req, res, siteName) {
  try {
    const htmlPath = path.join(BUILD_DIR, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).json({ error: 'Frontend build not found' });
    }
    
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    if (siteName) {
      const basePath = `/vpn/${siteName}/neocore`;
      if (!html.includes('<base')) {
        html = html.replace('<head>', `<head>\n<base href="${basePath}/">`);
      } else {
        html = html.replace(/<base[^>]*>/, `<base href="${basePath}/">`);
      }
    }
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

module.exports = { serveAsset, serveHTML };
