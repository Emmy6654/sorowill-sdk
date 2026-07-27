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

type ScVal = xdr.ScVal;

import { getPublicKey, signTransaction } from './wallet';
import { mapContractError, SoroWillError } from './errors';
import { RequestQueue } from './requestQueue';
import type {
  BatchOperation,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  RequestOptions,
  UpdateBeneficiariesParams,
  Will,
} from './types';
import { ReadCache, type ReadCacheOptions } from './cache';
import { RpcEndpointPool } from './rpc';
import { buildSep7TxUri, type BuildSep7TxUriOptions } from './sep7';
import type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
import { WillStatus } from './types';
import { assertPreparedTransactionMatchesIntendedOperation } from './txValidation';
import { getPublicKey, signTransaction } from './wallet';

const { Spec } = stellarContract;

/** An impossible account used to simulate read-only calls without a connected wallet. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Supported Stellar networks. */
export type SoroWillNetwork = 'testnet' | 'mainnet';

interface NetworkConfig {
  rpcUrls: string[];
  networkPassphrase: string;
}

const NETWORK_CONFIG: Record<SoroWillNetwork, NetworkConfig> = {
  testnet: {
    rpcUrls: ['https://soroban-testnet.stellar.org'],
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrls: ['https://mainnet.sorobanrpc.com'],
    networkPassphrase: Networks.PUBLIC,
  },
};

export interface SoroWillReadCacheOptions extends Pick<ReadCacheOptions, 'ttlMs'> {}

/** Options for constructing a {@link SoroWillClient}. */
export interface SoroWillClientOptions {
  /** Which Stellar network to connect to. */
  network: SoroWillNetwork;
  /** The deployed SoroWill contract's address. */
  contractId: string;
  /** Default timeout applied to each RPC request. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Maximum number of RPC requests in flight at once. Defaults to 4. */
  maxConcurrentRequests?: number;
  /** Maximum RPC requests started in a rolling one-second window. Defaults to 10. */
  requestsPerSecond?: number;
  /** Overrides the network's public RPC endpoint. Primarily useful for private RPC providers. */
  rpcUrl?: string;
  /** Optional list of RPC endpoints to use with automatic failover. */
  rpcUrls?: string[];
  /** Optional in-memory cache for read methods. */
  readCache?: SoroWillReadCacheOptions;
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

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via Freighter, so they require a
 * wallet to be connected first (see `connectWallet` in `./wallet`).
 */
export class SoroWillClient {
  private readonly rpcPool: RpcEndpointPool;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly queue: RequestQueue;
  private readonly timeoutMs: number;
  private readonly readCache: ReadCache | undefined;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    const rpcUrl = options.rpcUrl ?? config.rpcUrl;
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = config.networkPassphrase;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be greater than zero');
    }
    this.queue = new RequestQueue({
      ...(options.maxConcurrentRequests === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrentRequests }),
      ...(options.requestsPerSecond === undefined
        ? {}
        : { requestsPerSecond: options.requestsPerSecond }),
    });
    this.rpcPool = new RpcEndpointPool(options.rpcUrls ?? config.rpcUrls);
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = config.networkPassphrase;
    this.readCache = options.readCache ? new ReadCache(options.readCache) : undefined;
  }

  /** Locks `params.amount` of `params.token` and creates a new will. */
  async createWill(
    params: CreateWillParams,
    options?: RequestOptions,
  ): Promise<{ willId: string; txHash: string }> {
    const owner = await getPublicKey();
    const { txHash, returnValue } = await this.invoke('create_will', {
      owner,
      token: params.token,
      amount: BigInt(params.amount),
      beneficiaries: params.beneficiaries,
      checkin_period_days: BigInt(params.checkinPeriodDays),
      grace_period_days: BigInt(params.gracePeriodDays),
      guardians: params.guardians,
    }, options);
    if (!returnValue) {
      throw new Error('create_will transaction succeeded but returned no will id');
    }
    const spec = await this.getSpec(options);
    const willId = (spec.funcResToNative('create_will', returnValue) as bigint).toString();
    return { willId, txHash };
  }

  /** Resets the check-in countdown for `willId`. */
  async checkIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke('check_in', {
      will_id: BigInt(willId),
      owner,
    }, options);
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  }

  /** Starts the grace period for `willId` once the check-in deadline has passed. */
  async triggerWill(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke('trigger_will', { will_id: BigInt(willId) }, options);
    return { txHash };
  }

  /** Cancels an in-progress trigger during the grace period, resetting the countdown. */
  async emergencyCheckIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke('emergency_checkin', {
      will_id: BigInt(willId),
      owner,
    }, options);
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  }

  /** Distributes the will's balance to all beneficiaries once the grace period has elapsed. */
  async releaseInheritance(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke(
      'release_inheritance',
      { will_id: BigInt(willId) },
      options,
    );
    return { txHash };
  }

  /** Cancels the will and withdraws the full balance back to the owner. */
  async cancelWill(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; refundAmount: string }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash } = await this.invoke('cancel_will', {
      will_id: BigInt(willId),
      owner,
    }, options);
    return { txHash, refundAmount: will.balance };
  }

  /** Replaces the beneficiary list for a will before it has been triggered. */
  async updateBeneficiaries(
    params: UpdateBeneficiariesParams,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
    const { txHash } = await this.invoke('update_beneficiaries', {
      will_id: BigInt(params.willId),
      owner,
      beneficiaries: params.beneficiaries,
    }, options);
    return { txHash };
  }

  /** Adds more of the will's token to its locked balance. */
  async topUp(
    willId: string,
    amount: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
    const { txHash } = await this.invoke('top_up', {
      will_id: BigInt(willId),
      owner,
      amount: BigInt(amount),
    }, options);
    return { txHash };
  }

  /** Reads the full state of a will. Does not require a connected wallet. */
  async getWill(willId: string, options?: RequestOptions): Promise<Will> {
    const raw = await this.read<RawWill>('get_will', { will_id: BigInt(willId) }, options);
  async getWill(willId: string): Promise<Will> {
    const raw = await this.readCached(`get_will:${willId}`, () =>
      this.read<RawWill>('get_will', { will_id: BigInt(willId) }),
    );
    return mapWill(raw);
  }

  /** Lists every will owned by `owner`. Does not require a connected wallet. */
  async getWillsByOwner(owner: string, options?: RequestOptions): Promise<Will[]> {
    const raw = await this.read<RawWill[]>('get_wills_by_owner', { owner }, options);
  async getWillsByOwner(owner: string): Promise<Will[]> {
    const raw = await this.readCached(`get_wills_by_owner:${owner}`, () =>
      this.read<RawWill[]>('get_wills_by_owner', { owner }),
    );
    return raw.map(mapWill);
  }

  /** Lists every will `beneficiary` is named in. Does not require a connected wallet. */
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: RequestOptions,
  ): Promise<Will[]> {
    const raw = await this.read<RawWill[]>(
      'get_wills_by_beneficiary',
      { beneficiary },
      options,
  async getWillsByBeneficiary(beneficiary: string): Promise<Will[]> {
    const raw = await this.readCached(`get_wills_by_beneficiary:${beneficiary}`, () =>
      this.read<RawWill[]>('get_wills_by_beneficiary', { beneficiary }),
    );
    return raw.map(mapWill);
  }

  /**
   * Casts a guardian vote to force an early release of `willId`. Once 2 of
   * the will's guardians have voted, the balance is released automatically.
   */
  async guardianTrigger(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const guardian = await getPublicKey();
    const { txHash } = await this.invoke('guardian_trigger', {
      will_id: BigInt(willId),
      guardian,
    }, options);
    return { txHash };
  }

  /**
   * Combines contract calls into one atomic transaction and one wallet signature prompt.
   * Arguments use the native names and values accepted by the deployed contract spec.
   */
  async batch(operations: readonly BatchOperation[], options?: RequestOptions): Promise<BatchResult> {
    if (operations.length === 0) {
      throw new RangeError('A batch must contain at least one operation');
    }
    const spec = await this.getSpec(options);
    const contractOperations = operations.map(({ method, args }) =>
      this.contract.call(method, ...spec.funcArgsToScVals(method, args)),
    );
    const result = await this.submit(contractOperations, 'batch', options);
    return { txHash: result.txHash, createdAt: result.createdAt };
   * Builds a SEP-7 deep-link URI for a state-changing contract call, so a
   * mobile wallet can sign it outside the browser extension flow.
   */
  async buildSep7SigningUri(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey: string,
    options: BuildSep7TxUriOptions,
  ): Promise<string> {
    const prepared = await this.prepareInvocation(method, args, undefined, sourcePublicKey);
    return buildSep7TxUri(prepared.toXDR(), {
      ...options,
      networkPassphrase: options.networkPassphrase ?? this.networkPassphrase,
    });
  }

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(options?: RequestOptions): Promise<InstanceType<typeof Spec>> {
    if (!this.specPromise) {
      this.specPromise = this.rpc(
        () => this.server.getContractWasmByContractId(this.contract.contractId()),
        options,
      )
      this.specPromise = this.rpcPool
        .withFailover((server) => server.getContractWasmByContractId(this.contract.contractId()))
        .then((wasm) => Spec.fromWasm(wasm));
    }
    return this.specPromise;
  }

  private async readCached<T>(cacheKey: string, load: () => Promise<T>): Promise<T> {
    const cached = this.readCache?.get<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const value = await load();
    this.readCache?.set(cacheKey, value);
    return value;
  }

  /** Simulates a read-only contract call, requiring no connected wallet or signature. */
  private async read<T>(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    try {
      const spec = await this.getSpec(options);
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

      const simulation = await this.rpc(() => this.server.simulateTransaction(tx), options);
      if (rpc.Api.isSimulationError(simulation)) {
        throw new SoroWillError(`SoroWill simulation failed for ${method}: ${simulation.error}`);
      }
      if (!simulation.result) {
        throw new SoroWillError(`SoroWill simulation for ${method} returned no result`);
      }

      return spec.funcResToNative(method, simulation.result.retval) as T;
    } catch (error) {
      throw mapContractError(error);
  private async read<T>(method: string, args: Record<string, unknown>): Promise<T> {
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

    const simulation = await this.rpcPool.withFailover((server) => server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`SoroWill simulation failed for ${method}: ${simulation.error}`);
    }
    if (!simulation.result) {
      throw new Error(`SoroWill simulation for ${method} returned no result`);
    }
  }

  /** Builds, simulates, signs, and submits a state-changing contract call. */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    const spec = await this.getSpec(options);
    const operation = this.contract.call(method, ...spec.funcArgsToScVals(method, args));
    return this.submit([operation], method, options);
  }

  private async submit(
    operations: readonly xdr.Operation[],
    label: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    try {
      const publicKey = await getPublicKey();
      const account = await this.rpc(() => this.server.getAccount(publicKey), options);
      const builder = new TransactionBuilder(account, {
        fee: (BigInt(BASE_FEE) * BigInt(operations.length)).toString(),
        networkPassphrase: this.networkPassphrase,
      });
      for (const operation of operations) builder.addOperation(operation);
      const builtTx = builder.setTimeout(30).build();

      // prepareTransaction simulates and assembles Soroban data for the whole transaction.
      const prepared = await this.rpc(() => this.server.prepareTransaction(builtTx), options);
      const signedTxXdr = await signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(
        signedTxXdr,
        this.networkPassphrase,
      ) as Transaction;

      const sendResponse = await this.rpc(() => this.server.sendTransaction(signedTx), options);
      if (sendResponse.status === 'ERROR') {
        const errorXdr = sendResponse.errorResult?.toXDR('base64') ?? 'no error result';
        throw new SoroWillError(
          `SoroWill transaction submission failed for ${label}: ${errorXdr}`,
        );
      }

      const txResponse = await this.rpc(
        () => this.server.pollTransaction(sendResponse.hash, { attempts: 30 }),
        options,
      );
      if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new SoroWillError(
          `SoroWill transaction for ${label} did not succeed: ${txResponse.status}`,
        );
      }

      return {
        txHash: sendResponse.hash,
        createdAt: txResponse.createdAt,
        returnValue: txResponse.returnValue,
      };
    } catch (error) {
      throw mapContractError(error);
    const builtTx = await this.buildInvocationTransaction(method, args);
    const prepared = await this.prepareInvocation(method, args, builtTx);

    assertPreparedTransactionMatchesIntendedOperation({
      intendedTransactionXdr: builtTx.toXDR(),
      preparedTransactionXdr: prepared.toXDR(),
      networkPassphrase: this.networkPassphrase,
      context: method,
    });

    const signedTxXdr = await signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;

    const sendResponse = await this.rpcPool.withFailover((server) => server.sendTransaction(signedTx));
    if (sendResponse.status === 'ERROR') {
      throw new Error(`SoroWill transaction submission failed for ${method}`);
    }

    const txResponse = await this.rpcPool.withFailover((server) =>
      server.pollTransaction(sendResponse.hash, { attempts: 30 }),
    );
    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`SoroWill transaction for ${method} did not succeed: ${txResponse.status}`);
    }
  }

  /** Sends every RPC through the shared FIFO queue with the selected timeout. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions): Promise<T> {
    return this.queue.enqueue(request, options?.timeoutMs ?? this.timeoutMs);
    this.readCache?.clear();

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  private async buildInvocationTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const publicKey = sourcePublicKey ?? (await getPublicKey());
    const account = await this.rpcPool.withFailover((server) => server.getAccount(publicKey));
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
  }

  private async prepareInvocation(
    method: string,
    args: Record<string, unknown>,
    builtTx?: Transaction,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const transaction = builtTx ?? (await this.buildInvocationTransaction(method, args, sourcePublicKey));
    return this.rpcPool.withFailover((server) => server.prepareTransaction(transaction));
  }
}
