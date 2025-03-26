// Session management for the PostgreSQL HTTP proxy server

// Session storage to maintain context between requests (mimicking Neon's architecture)
const sessionStorage = new Map();

// Helper function to extract client identifier from request - used to maintain session state
function getClientIdentifier(request) {
  // Primary identifier - use X-Session-ID header if provided
  // This matches Neon's implementation which uses a UUID session ID
  const sessionId = request.headers['x-session-id'];
  if (sessionId) {
    return `session:${sessionId}`;
  }
  
  // Auth token is still important but not the only signal
  const authHeader = request.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    return `auth:${token}`;
  }

  // Client IP address is a strong signal for session continuity
  const clientIp = request.ip || request.headers['x-forwarded-for'] || 'unknown-ip';
  
  // User agent is fairly consistent for a client
  const userAgent = request.headers['user-agent'] || '';
  
  // Fallback to connection-based identification when no auth token or session ID
  return `conn:${clientIp}:${userAgent.substring(0, 30)}`;
}

// Helper to create or get a session for this client
function getOrCreateSession(request) {
  const clientId = getClientIdentifier(request);
  if (!sessionStorage.has(clientId)) {
    sessionStorage.set(clientId, {
      lastActivity: Date.now(),
      returningValues: new Map(), // Store values from RETURNING clauses
      latestTableData: new Map()  // Store latest table data by table name
    });
  } else {
    // Update last activity
    const session = sessionStorage.get(clientId);
    session.lastActivity = Date.now();
  }

  return sessionStorage.get(clientId);
}

// Clean up old sessions periodically (every 5 minutes)
function setupSessionCleanup(logger) {
  return setInterval(() => {
    const now = Date.now();
    const expiryTime = 30 * 60 * 1000; // 30 minutes

    for (const [clientId, session] of sessionStorage.entries()) {
      if (now - session.lastActivity > expiryTime) {
        sessionStorage.delete(clientId);
        logger.info({ clientId }, 'Session expired and removed');
      }
    }
  }, 5 * 60 * 1000);
}

module.exports = {
  sessionStorage,
  getClientIdentifier,
  getOrCreateSession,
  setupSessionCleanup
};
