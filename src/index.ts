export { SoroWillClient } from './SoroWillClient';
export type { SoroWillClientOptions, SoroWillNetwork } from './SoroWillClient';

export type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
export { WillStatus } from './types';

export { connectWallet, getPublicKey, isFreighterInstalled, signTransaction } from './wallet';
export type { WalletConnection } from './wallet';

export {
  HanaWalletAdapter,
  HotWalletAdapter,
  LedgerWalletAdapter,
  LobstrWalletAdapter,
} from './adapters';
export type {
  InjectedWalletProvider,
  LedgerStellarApp,
  LedgerTransport,
  LedgerWalletAdapterOptions,
  LobstrSessionClient,
  LobstrWalletAdapterOptions,
  SignTransactionOptions,
  WalletAdapter,
} from './adapters';

export {
  calculateShares,
  formatDeadline,
  formatUSDC,
  getTimeUntilCheckin,
  isCheckinDue,
  toStroops,
  validateBeneficiaries,
} from './utils';
