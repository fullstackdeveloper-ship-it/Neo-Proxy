/**
 * Session Manager
 * Manages session IDs and maps them to sites
 */

const crypto = require('crypto');

// Session storage: sessionId -> { siteName, createdAt, lastAccess }
const sessions = new Map();
// Reverse: siteName -> Set of sessionIds (for cleanup)
const siteSessions = new Map();

/**
 * Create session for a site
 */
function createSession(siteName) {
  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, {
    siteName,
    createdAt: Date.now(),
    lastAccess: Date.now()
  });
  
  // Track sessions per site
  if (!siteSessions.has(siteName)) {
    siteSessions.set(siteName, new Set());
  }
  siteSessions.get(siteName).add(sessionId);
  
  console.log(`✅ Session created: ${sessionId.substring(0, 8)}... → ${siteName}`);
  return sessionId;
}

/**
 * Get site from session ID
 */
function getSiteFromSession(sessionId) {
  if (!sessionId) return null;
  
  const session = sessions.get(sessionId);
  if (session) {
    session.lastAccess = Date.now();
    return session.siteName;
  }
  return null;
}

/**
 * Validate session exists
 */
function isValidSession(sessionId) {
  return sessions.has(sessionId);
}

/**
 * Cleanup old sessions (optional - for memory management)
 */
function cleanupOldSessions(maxAge = 24 * 60 * 60 * 1000) { // 24 hours
  const now = Date.now();
  let cleaned = 0;
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccess > maxAge) {
      const siteName = session.siteName;
      sessions.delete(sessionId);
      if (siteSessions.has(siteName)) {
        siteSessions.get(siteName).delete(sessionId);
      }
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} old sessions`);
  }
}

// Run cleanup every hour
setInterval(() => {
  cleanupOldSessions();
}, 60 * 60 * 1000);

module.exports = {
  createSession,
  getSiteFromSession,
  isValidSession,
  cleanupOldSessions
};
