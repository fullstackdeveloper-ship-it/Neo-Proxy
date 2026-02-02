/**
 * Assets Service - Serves static files and HTML
 */

const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '../build');
const ASSETS_DIR = path.join(BUILD_DIR, 'static');

/**
 * Find main JS and CSS files dynamically from build/static
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
 * Get current main JS and CSS paths (asset-manifest.json or scan build/static)
 */
function getMainAssetPaths() {
  const manifestPath = path.join(BUILD_DIR, 'asset-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const mainJs = manifest.files?.['main.js'] || manifest.entrypoints?.find(e => e.endsWith('.js'));
      const mainCss = manifest.files?.['main.css'] || manifest.entrypoints?.find(e => e.endsWith('.css'));
      if (mainJs && mainCss) return { jsPath: mainJs.startsWith('/') ? mainJs : '/' + mainJs, cssPath: mainCss.startsWith('/') ? mainCss : '/' + mainCss };
    } catch (e) {}
  }
  const { jsFile, cssFile } = findAssetFiles();
  if (jsFile && cssFile) {
    return { jsPath: `/static/${jsFile}`, cssPath: `/static/${cssFile}` };
  }
  return null;
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
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {string} siteName - Site slug
 * @param {string} neocoreId - NeoCore instance slug (e.g. '0', '1') for multiple neocores per site
 */
function serveHTML(req, res, siteName, neocoreId) {
  try {
    const htmlPath = path.join(BUILD_DIR, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).json({ error: 'Frontend build not found' });
    }

    let html = fs.readFileSync(htmlPath, 'utf8');

    // Rewrite script/link to current main JS/CSS from build (survives new builds)
    const assets = getMainAssetPaths();
    if (assets) {
      html = html.replace(/src="\/static\/js\/main\.[^"]+\.js"/, `src="${assets.jsPath}"`);
      html = html.replace(/href="\/static\/css\/main\.[^"]+\.css"/, `href="${assets.cssPath}"`);
    }

    if (siteName) {
      const basePath = neocoreId
        ? `/vpn/${siteName}/neocore/${neocoreId}`
        : `/vpn/${siteName}/neocore`;
      if (!html.includes('<base')) {
        html = html.replace('<head>', `<head>\n<base href="${basePath}/">`);
      } else {
        html = html.replace(/<base[^>]*>/, `<base href="${basePath}/">`);
      }

      res.cookie('vpn-site', siteName, {
        httpOnly: false,
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
        sameSite: 'lax',
      });
      if (neocoreId) {
        res.cookie('vpn-neocore', neocoreId, {
          httpOnly: false,
          maxAge: 24 * 60 * 60 * 1000,
          path: '/',
          sameSite: 'lax',
        });
      }
    }

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(html);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

module.exports = { serveAsset, serveHTML };
