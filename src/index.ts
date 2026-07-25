export { SoroWillClient } from './SoroWillClient';
export type { SoroWillClientOptions, SoroWillNetwork } from './SoroWillClient';

export type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
export { WillStatus } from './types';

export {
  connectWallet,
  freighterAdapter,
  getPublicKey,
  isFreighterInstalled,
  signTransaction,
} from './wallet';
export type { WalletAdapter, WalletConnection } from './wallet';

export { createAlbedoAdapter } from './adapters/albedo';

export {
  calculateShares,
  formatDeadline,
  formatUSDC,
  getTimeUntilCheckin,
  isCheckinDue,
  toStroops,
  validateBeneficiaries,
} from './utils';
