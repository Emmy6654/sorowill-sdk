export { SoroWillClient } from './SoroWillClient';
export type { SoroWillClientOptions, SoroWillNetwork } from './SoroWillClient';

export type {
  BatchOperation,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  RequestOptions,
  UpdateBeneficiariesParams,
  Will,
} from './types';
export { WillStatus } from './types';

export {
  AlreadyVotedError,
  CheckinNotDueError,
  GracePeriodExpiredError,
  GracePeriodNotExpiredError,
  InvalidPercentagesError,
  NotGuardianError,
  NotOwnerError,
  RequestTimeoutError,
  SoroWillError,
  TooManyBeneficiariesError,
  WillContractError,
  WillNotActiveError,
  WillNotFoundError,
  WillNotTriggeredError,
  ZeroAmountError,
} from './errors';
export { RequestQueue } from './requestQueue';
export type { RequestQueueOptions } from './requestQueue';

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
