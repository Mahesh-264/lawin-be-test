const mongoose = require('mongoose');

const ensureConnected = async (connection = mongoose.connection) => {
  if (connection.readyState === 1) return connection;
  if (connection.readyState === 2) {
    await connection.asPromise();
    if (connection.readyState === 1) return connection;
  }
  throw new Error('MongoDB connection is not ready');
};

const supportsTransactions = async (connection = mongoose.connection) => {
  await ensureConnected(connection);
  // The server response is authoritative. Driver topology labels alone can be
  // stale or misleading behind proxies/load balancers, which caused sessions
  // to attempt transactions against an unsupported server.
  const hello = await connection.db.admin().command({ hello: 1 });
  return Boolean(hello.setName || hello.msg === 'isdbgrid' || hello.serviceId);
};

const runInTransaction = async (work, options = {}) => {
  const connection = await ensureConnected(options.connection || mongoose.connection);
  // A caller already inside a transaction must reuse its session instead of
  // opening a nested transaction.
  if (options.session) return work(options.session);

  const canUseTransactions = await supportsTransactions(connection);
  const fallbackToNonTransactional = options.fallbackToNonTransactional ?? process.env.NODE_ENV !== 'production';

  if (!canUseTransactions) {
    if (!fallbackToNonTransactional) {
      throw new Error('MongoDB transactions are unavailable for the current connection topology');
    }

    if (options.logger) {
      options.logger('[mongo] Transactions unavailable for the current topology; using non-transactional writes');
    }
    return work(null);
  }

  const session = await connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  ensureConnected,
  supportsTransactions,
  runInTransaction,
};
