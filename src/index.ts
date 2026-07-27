export { SoroWillClient } from './SoroWillClient';
export type { SoroWillClientOptions, SoroWillNetwork } from './SoroWillClient';

export { HookManager } from './hooks';
export type {
  AfterInvokeContext,
  AfterInvokeHook,
  BeforeInvokeContext,
  BeforeInvokeHook,
  HookRegistry,
} from './hooks';

export type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
export { WillStatus } from './types';

export { connectWallet, getPublicKey, isFreighterInstalled, signTransaction } from './wallet';
export type { WalletConnection } from './wallet';

export {
  calculateShares,
  formatDeadline,
  formatUSDC,
  getTimeUntilCheckin,
  isCheckinDue,
  toStroops,
  validateBeneficiaries,
} from './utils';
