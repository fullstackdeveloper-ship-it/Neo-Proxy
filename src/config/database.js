/**
 * Database Configuration
 * Connects to NeoSphere PostgreSQL database to fetch dashboard configurations
 */

const { Pool } = require('pg');

/**
 * Create PostgreSQL connection pool
 */
function createDatabasePool() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
    database: process.env.DB_NAME || 'mydb',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 5000, // Return an error after 5 seconds if connection cannot be established
  });

  // Log connection events
  pool.on('connect', () => {
    console.log('✅ Database connection established');
  });

  pool.on('error', (err) => {
    console.error('❌ Unexpected database pool error:', err);
  });

  return pool;
}

/**
 * Test database connection
 */
async function testConnection(pool) {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Database connection test successful:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('❌ Database connection test failed:', error.message);
    return false;
  }
}

module.exports = {
  createDatabasePool,
  testConnection,
};
