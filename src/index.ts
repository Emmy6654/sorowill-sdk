export { SoroWillClient } from './SoroWillClient';
export type {
  RpcRetryOptions,
  SoroWillClientOptions,
  SoroWillNetwork,
  SoroWillRpcServer,
} from './SoroWillClient';

export type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
export { WillStatus } from './types';

export {
  connectWallet,
  FreighterWalletAdapter,
  getDefaultWalletAdapter,
  getPublicKey,
  isFreighterInstalled,
  signTransaction,
} from './wallet';
export type { WalletAdapter, WalletConnection } from './wallet';

export {
  LocalStorageWalletConnectSessionStore,
  MemoryWalletConnectSessionStore,
  WalletConnectAdapter,
} from './walletConnect';
export type {
  WalletConnectAdapterOptions,
  WalletConnectClient,
  WalletConnectConnectResult,
  WalletConnectSession,
  WalletConnectSessionNamespace,
  WalletConnectSessionStore,
} from './walletConnect';

export {
  IndexedDbCachePersistenceAdapter,
  LocalStorageCachePersistenceAdapter,
  MemoryCachePersistenceAdapter,
  ReadCache,
  createReadCacheKey,
} from './cache';
export type { CachePersistenceAdapter, PersistedCacheEntry, ReadCacheOptions } from './cache';

export { unsubscribeFromWillEvents } from './events';
export type {
  WillEvent,
  WillEventListener,
  WillEventSource,
  WillEventSubscription,
} from './events';

export {
  calculateShares,
  formatDeadline,
  formatUSDC,
  getTimeUntilCheckin,
  isCheckinDue,
  toStroops,
  validateBeneficiaries,
} from './utils';
