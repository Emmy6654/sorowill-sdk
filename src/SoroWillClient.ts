import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
  contract as stellarContract,
} from '@stellar/stellar-sdk';

import {
  ReadCache,
  createReadCacheKey,
  type ReadCacheOptions,
} from './cache';
import {
  unsubscribeFromWillEvents,
  type WillEventSource,
  type WillEventSubscription,
} from './events';
import type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
import { WillStatus } from './types';
import { getDefaultWalletAdapter, type WalletAdapter } from './wallet';

type ScVal = xdr.ScVal;

const { Spec } = stellarContract;

/** An impossible account used to simulate read-only calls without a connected wallet. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Supported Stellar networks. */
export type SoroWillNetwork = 'testnet' | 'mainnet';

interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

const NETWORK_CONFIG: Record<SoroWillNetwork, NetworkConfig> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: Networks.PUBLIC,
  },
};

export interface RpcRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export interface SoroWillRpcServer {
  getContractWasmByContractId(contractId: string): Promise<Buffer | Uint8Array>;
  simulateTransaction(transaction: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  getAccount(address: string): Promise<Account>;
  prepareTransaction(transaction: Transaction): Promise<Transaction>;
  sendTransaction(transaction: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(
    hash: string,
    options: { attempts: number },
  ): Promise<rpc.Api.GetTransactionResponse>;
}

interface ContractSpecLike {
  funcArgsToScVals(method: string, args: Record<string, unknown>): ScVal[];
  funcResToNative(method: string, value: ScVal): unknown;
}

/** Options for constructing a {@link SoroWillClient}. */
export interface SoroWillClientOptions {
  /** Which Stellar network to connect to. */
  network: SoroWillNetwork;
  /** The deployed SoroWill contract's address. */
  contractId: string;
  /** Wallet adapter used for state-changing calls. Defaults to Freighter. */
  wallet?: WalletAdapter;
  /** Read-cache configuration. Pass `false` to disable caching entirely. */
  readCache?: ReadCacheOptions | false;
  /** Event source used to invalidate cached will reads as external updates arrive. */
  eventSource?: WillEventSource;
  /** Retry settings for transient RPC failures. */
  retry?: Partial<RpcRetryOptions>;
  /** Advanced override for testing or custom transports. */
  rpcServer?: SoroWillRpcServer;
  /** Advanced override for testing or preloaded contract specs. */
  spec?: ContractSpecLike | Promise<ContractSpecLike>;
}

/** The raw, snake_case shape of a `Will` as decoded straight off the contract spec. */
interface RawWill {
  id: bigint;
  owner: string;
  token: string;
  balance: bigint;
  beneficiaries: Beneficiary[];
  checkin_period_days: bigint;
  grace_period_days: bigint;
  last_checkin: bigint;
  trigger_time: bigint | undefined;
  status: WillStatus;
  guardians: string[];
  guardian_votes: number;
}

const DEFAULT_RETRY_OPTIONS: RpcRetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  backoffFactor: 2,
};

function mapWill(raw: RawWill): Will {
  return {
    id: raw.id.toString(),
    owner: raw.owner,
    token: raw.token,
    balance: raw.balance.toString(),
    beneficiaries: raw.beneficiaries,
    checkinPeriodDays: Number(raw.checkin_period_days),
    gracePeriodDays: Number(raw.grace_period_days),
    lastCheckin: new Date(Number(raw.last_checkin) * 1000),
    triggerTime: raw.trigger_time === undefined ? null : new Date(Number(raw.trigger_time) * 1000),
    status: raw.status,
    guardians: raw.guardians,
    guardianVotes: raw.guardian_votes,
  };
}

function getWillIdsFromReadResult(
  method: string,
  args: Record<string, unknown>,
  result: unknown,
): string[] {
  if (method === 'get_will' && typeof args.will_id === 'bigint') {
    return [args.will_id.toString()];
  }

  if (Array.isArray(result)) {
    return result
      .filter((item): item is RawWill => Boolean(item) && typeof item === 'object' && 'id' in item)
      .map((item) => item.id.toString());
  }

  return [];
}

function getMutationWillIds(_method: string, args: Record<string, unknown>): string[] {
  if (typeof args.will_id === 'bigint') {
    return [args.will_id.toString()];
  }

  return [];
}

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via the configured wallet adapter.
 */
export class SoroWillClient {
  private readonly server: SoroWillRpcServer;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly wallet: WalletAdapter;
  private readonly retryOptions: RpcRetryOptions;
  private readonly readCache: ReadCache | undefined;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private specPromise: Promise<ContractSpecLike> | undefined;
  private readonly eventSubscription?: WillEventSubscription;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    this.server =
      options.rpcServer ??
      new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = config.networkPassphrase;
    this.wallet = options.wallet ?? getDefaultWalletAdapter();
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    this.readCache = options.readCache === false ? undefined : new ReadCache(options.readCache);
    this.specOverride = options.spec;

    if (this.readCache && options.eventSource) {
      this.eventSubscription = options.eventSource.subscribe((event) => {
        void this.readCache?.invalidateByWillId(event.willId);
      });
    }
  }

  /** Locks `params.amount` of `params.token` and creates a new will. */
  async createWill(params: CreateWillParams): Promise<{ willId: string; txHash: string }> {
    const owner = await this.wallet.getPublicKey();
    const { txHash, returnValue } = await this.invoke('create_will', {
      owner,
      token: params.token,
      amount: BigInt(params.amount),
      beneficiaries: params.beneficiaries,
      checkin_period_days: BigInt(params.checkinPeriodDays),
      grace_period_days: BigInt(params.gracePeriodDays),
      guardians: params.guardians,
    });
    if (!returnValue) {
      throw new Error('create_will transaction succeeded but returned no will id');
    }
    const spec = await this.getSpec();
    const willId = (spec.funcResToNative('create_will', returnValue) as bigint).toString();
    return { willId, txHash };
  }

  /** Resets the check-in countdown for `willId`. */
  async checkIn(willId: string): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId);
    const { txHash, createdAt } = await this.invoke('check_in', {
      will_id: BigInt(willId),
      owner,
    });
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  }

  /** Starts the grace period for `willId` once the check-in deadline has passed. */
  async triggerWill(willId: string): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke('trigger_will', { will_id: BigInt(willId) });
    return { txHash };
  }

  /** Cancels an in-progress trigger during the grace period, resetting the countdown. */
  async emergencyCheckIn(willId: string): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId);
    const { txHash, createdAt } = await this.invoke('emergency_checkin', {
      will_id: BigInt(willId),
      owner,
    });
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  }

  /** Distributes the will's balance to all beneficiaries once the grace period has elapsed. */
  async releaseInheritance(willId: string): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke('release_inheritance', { will_id: BigInt(willId) });
    return { txHash };
  }

  /** Cancels the will and withdraws the full balance back to the owner. */
  async cancelWill(willId: string): Promise<{ txHash: string; refundAmount: string }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId);
    const { txHash } = await this.invoke('cancel_will', {
      will_id: BigInt(willId),
      owner,
    });
    return { txHash, refundAmount: will.balance };
  }

  /** Replaces the beneficiary list for a will before it has been triggered. */
  async updateBeneficiaries(params: UpdateBeneficiariesParams): Promise<{ txHash: string }> {
    const owner = await this.wallet.getPublicKey();
    const { txHash } = await this.invoke('update_beneficiaries', {
      will_id: BigInt(params.willId),
      owner,
      beneficiaries: params.beneficiaries,
    });
    return { txHash };
  }

  /** Adds more of the will's token to its locked balance. */
  async topUp(willId: string, amount: string): Promise<{ txHash: string }> {
    const owner = await this.wallet.getPublicKey();
    const { txHash } = await this.invoke('top_up', {
      will_id: BigInt(willId),
      owner,
      amount: BigInt(amount),
    });
    return { txHash };
  }

  /** Reads the full state of a will. Does not require a connected wallet. */
  async getWill(willId: string): Promise<Will> {
    const raw = await this.read<RawWill>('get_will', { will_id: BigInt(willId) });
    return mapWill(raw);
  }

  /** Lists every will owned by `owner`. Does not require a connected wallet. */
  async getWillsByOwner(owner: string): Promise<Will[]> {
    const raw = await this.read<RawWill[]>('get_wills_by_owner', { owner });
    return raw.map(mapWill);
  }

  /** Lists every will `beneficiary` is named in. Does not require a connected wallet. */
  async getWillsByBeneficiary(beneficiary: string): Promise<Will[]> {
    const raw = await this.read<RawWill[]>('get_wills_by_beneficiary', { beneficiary });
    return raw.map(mapWill);
  }

  /**
   * Casts a guardian vote to force an early release of `willId`. Once 2 of
   * the will's guardians have voted, the balance is released automatically.
   */
  async guardianTrigger(willId: string): Promise<{ txHash: string }> {
    const guardian = await this.wallet.getPublicKey();
    const { txHash } = await this.invoke('guardian_trigger', {
      will_id: BigInt(willId),
      guardian,
    });
    return { txHash };
  }

  /** Unsubscribes from any configured event source. */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
    }
  }

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(): Promise<ContractSpecLike> {
    if (!this.specPromise) {
      if (this.specOverride) {
        this.specPromise = Promise.resolve(this.specOverride);
      } else {
        this.specPromise = this.server
          .getContractWasmByContractId(this.contract.contractId())
          .then((wasm) => Spec.fromWasm(Buffer.from(wasm)));
      }
    }
    return await this.specPromise;
  }

  /** Simulates a read-only contract call, requiring no connected wallet or signature. */
  private async read<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const cacheKey = createReadCacheKey(method, args);
    const cached = await this.readCache?.get<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const account = new Account(NULL_ACCOUNT, '0');
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.retryRpc(`simulateTransaction(${method})`, async () => {
      return await this.server.simulateTransaction(tx);
    });

    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`SoroWill simulation failed for ${method}: ${simulation.error}`);
    }
    if (!simulation.result) {
      throw new Error(`SoroWill simulation for ${method} returned no result`);
    }

    const result = spec.funcResToNative(method, simulation.result.retval) as T;
    await this.readCache?.set(cacheKey, result, getWillIdsFromReadResult(method, args, result));
    return result;
  }

  /** Builds, simulates, signs, and submits a state-changing contract call. */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const publicKey = await this.wallet.getPublicKey();
    const account = await this.server.getAccount(publicKey);
    const builtTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(builtTx);
    const signedTxXdr = await this.wallet.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;

    const sendResponse = await this.retryRpc(`sendTransaction(${method})`, async () => {
      return await this.server.sendTransaction(signedTx);
    });
    if (sendResponse.status === 'ERROR') {
      throw new Error(`SoroWill transaction submission failed for ${method}`);
    }

    const txResponse = await this.retryRpc(`pollTransaction(${method})`, async () => {
      return await this.server.pollTransaction(sendResponse.hash, { attempts: 30 });
    });
    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`SoroWill transaction for ${method} did not succeed: ${txResponse.status}`);
    }

    if (method === 'create_will') {
      await this.readCache?.clear();
    } else {
      const affectedWillIds = getMutationWillIds(method, args);
      await Promise.all(affectedWillIds.map((willId) => this.readCache?.invalidateByWillId(willId)));
    }

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  private async retryRpc<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let delayMs = this.retryOptions.initialDelayMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryOptions.maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === this.retryOptions.maxAttempts) {
          break;
        }

        await this.sleep(delayMs);
        delayMs = Math.min(
          this.retryOptions.maxDelayMs,
          Math.max(delayMs, 1) * this.retryOptions.backoffFactor,
        );
      }
    }

    throw new Error(
      `SoroWill RPC call ${label} failed after ${this.retryOptions.maxAttempts} attempts: ${String(lastError)}`,
    );
  }

  private async sleep(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }
}
