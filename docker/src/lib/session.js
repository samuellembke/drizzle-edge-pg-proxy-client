// Session management for the PostgreSQL HTTP proxy server

// Session storage to maintain context between requests (matching Neon's approach)
const sessionStorage = new Map();

// Helper function to extract client identifier from request
function getClientIdentifier(request) {
  // Primary identifier - use X-Session-ID header if provided
  const sessionId = request.headers['x-session-id'];
  if (sessionId) {
    return `session:${sessionId}`;
  }

  // Fallback to auth token or connection info
  const authHeader = request.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    return `auth:${token}`;
  }

  // Use connection info as last resort
  const clientIp = request.ip || request.headers['x-forwarded-for'] || 'unknown-ip';
  const userAgent = request.headers['user-agent'] || '';
  return `conn:${clientIp}:${userAgent.substring(0, 30)}`;
}

// Get or create a session for this client
function getOrCreateSession(request) {
  const clientId = getClientIdentifier(request);
  
  if (!sessionStorage.has(clientId)) {
    sessionStorage.set(clientId, {
      lastActivity: Date.now(),
      returningValues: new Map() // Simple key-value store for values from RETURNING clauses
    });
  } else {
    // Update last activity timestamp
    const session = sessionStorage.get(clientId);
    session.lastActivity = Date.now();
  }

  return sessionStorage.get(clientId);
}

// Clean up old sessions periodically
function setupSessionCleanup(logger) {
  return setInterval(() => {
    const now = Date.now();
    // Sessions expire after 30 minutes of inactivity
    const expiryTime = 30 * 60 * 1000;

    let expiredCount = 0;
    for (const [clientId, session] of sessionStorage.entries()) {
      if (now - session.lastActivity > expiryTime) {
        sessionStorage.delete(clientId);
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      logger.debug({ 
        expiredCount, 
        remainingCount: sessionStorage.size 
      }, 'Expired sessions removed');
    }
  }, 5 * 60 * 1000); // Run cleanup every 5 minutes
}

module.exports = {
  sessionStorage,
  getClientIdentifier,
  getOrCreateSession,
  setupSessionCleanup
};
