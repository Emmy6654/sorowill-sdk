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
import type {
  Beneficiary,
  CreateWillParams,
  EventSubscription,
  EventSubscriptionOptions,
  PaginatedWillsResult,
  PaginationOptions,
  SoroWillEvent,
  UpdateBeneficiariesParams,
  Will,
} from './types';
import { WillStatus } from './types';

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

type EnvSource = Record<string, string | undefined>;
type FetchImplementation = typeof fetch;

interface WebSocketLike {
  close(): void;
  send(data: string): void;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: Event | unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: ((event: Event | unknown) => void) | null;
}

interface JsonRpcSuccess<T> {
  result: T;
}

interface JsonRpcFailure {
  error: {
    code?: number;
    message?: string;
  };
}

interface RpcEventRecord {
  contractId?: string;
  id?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  pagingToken?: string;
  topic?: unknown[];
  topics?: unknown[];
  txHash?: string;
  type?: string;
  value?: unknown;
}

interface RpcEventPage {
  events?: RpcEventRecord[];
  nextCursor?: string | null;
}

/** Options for constructing a {@link SoroWillClient}. */
export interface SoroWillClientOptions {
  /** Which Stellar network to connect to. */
  network: SoroWillNetwork;
  /** The deployed SoroWill contract's address. */
  contractId: string;
  /** Optional override for the Soroban RPC endpoint. */
  rpcUrl?: string;
  /** Optional override for the Stellar network passphrase. */
  networkPassphrase?: string;
  /** Optional override for the endpoint used for event polling. */
  eventRpcUrl?: string;
  /** Optional override for the WebSocket event streaming endpoint. */
  eventStreamUrl?: string;
  /** Default polling interval for event subscriptions. */
  defaultPollIntervalMs?: number;
  /** Internal/testing override for the fetch implementation. */
  fetch?: FetchImplementation;
  /** Internal/testing override for WebSocket construction. */
  webSocketFactory?: (url: string) => WebSocketLike;
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

interface SimulatedCallResult {
  result?: {
    retval: ScVal;
  };
  minResourceFee?: string;
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

function mapEventRecord(record: RpcEventRecord, fallbackContractId: string): SoroWillEvent {
  const cursor = record.pagingToken ?? record.id ?? '';
  return {
    id: record.id ?? cursor,
    cursor,
    ledger: record.ledger ?? null,
    ledgerClosedAt: record.ledgerClosedAt ? new Date(record.ledgerClosedAt) : null,
    contractId: record.contractId ?? fallbackContractId,
    txHash: record.txHash ?? null,
    type: record.type ?? null,
    topics: record.topics ?? record.topic ?? [],
    value: record.value,
    raw: record,
  };
}

function isPaginationRequested(options: PaginationOptions | undefined): options is PaginationOptions {
  return options !== undefined && (options.pageSize !== undefined || options.cursor !== undefined);
}

function paginateWills(wills: Will[], options: PaginationOptions | undefined): Will[] | PaginatedWillsResult {
  if (!isPaginationRequested(options)) {
    return wills;
  }

  const start = parseCursor(options.cursor);
  const pageSize = normalizePositiveInteger(options.pageSize, 'pageSize');
  const end = pageSize === null ? wills.length : Math.min(start + pageSize, wills.length);

  return {
    wills: wills.slice(start, end),
    nextCursor: end < wills.length ? String(end) : null,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new Error(`Invalid pagination cursor: "${cursor}"`);
  }
  return Number(cursor);
}

function normalizePositiveInteger(value: number | undefined, label: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function getDefaultEnv(): EnvSource {
  if (typeof process !== 'undefined' && process.env) {
    return process.env;
  }
  return {};
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via Freighter, so they require a
 * wallet to be connected first (see `connectWallet` in `./wallet`).
 */
export class SoroWillClient {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly eventRpcUrl: string;
  private readonly eventStreamUrl: string;
  private readonly defaultPollIntervalMs: number;
  private readonly fetchImplementation?: FetchImplementation;
  private readonly webSocketFactory?: (url: string) => WebSocketLike;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    const rpcUrl = options.rpcUrl ?? config.rpcUrl;
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase ?? config.networkPassphrase;
    this.eventRpcUrl = options.eventRpcUrl ?? rpcUrl;
    this.eventStreamUrl = options.eventStreamUrl ?? this.deriveDefaultEventStreamUrl(this.eventRpcUrl);
    this.defaultPollIntervalMs = normalizePositiveInteger(
      options.defaultPollIntervalMs,
      'defaultPollIntervalMs',
    ) ?? 5_000;
    this.fetchImplementation = options.fetch;
    this.webSocketFactory = options.webSocketFactory;
  }

  /**
   * Constructs a client from environment variables.
   *
   * Expected variables:
   * - `SOROWILL_NETWORK`
   * - `SOROWILL_CONTRACT_ID`
   * - `SOROWILL_RPC_URL` (optional)
   * - `SOROWILL_NETWORK_PASSPHRASE` (optional)
   * - `SOROWILL_EVENT_RPC_URL` (optional)
   * - `SOROWILL_EVENT_STREAM_URL` (optional)
   * - `SOROWILL_EVENTS_POLL_INTERVAL_MS` (optional)
   */
  static fromEnv(env: EnvSource = getDefaultEnv()): SoroWillClient {
    const network = env.SOROWILL_NETWORK;
    if (network !== 'testnet' && network !== 'mainnet') {
      throw new Error('SOROWILL_NETWORK must be set to "testnet" or "mainnet"');
    }

    const contractId = env.SOROWILL_CONTRACT_ID;
    if (!contractId) {
      throw new Error('SOROWILL_CONTRACT_ID must be set');
    }

    const pollInterval = env.SOROWILL_EVENTS_POLL_INTERVAL_MS
      ? Number(env.SOROWILL_EVENTS_POLL_INTERVAL_MS)
      : undefined;

    return new SoroWillClient({
      network,
      contractId,
      rpcUrl: env.SOROWILL_RPC_URL,
      networkPassphrase: env.SOROWILL_NETWORK_PASSPHRASE,
      eventRpcUrl: env.SOROWILL_EVENT_RPC_URL,
      eventStreamUrl: env.SOROWILL_EVENT_STREAM_URL,
      defaultPollIntervalMs: pollInterval,
    });
  }

  /** Locks `params.amount` of `params.token` and creates a new will. */
  async createWill(params: CreateWillParams): Promise<{ willId: string; txHash: string }> {
    const owner = await getPublicKey();
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
    const owner = await getPublicKey();
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
    const owner = await getPublicKey();
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
    const owner = await getPublicKey();
    const will = await this.getWill(willId);
    const { txHash } = await this.invoke('cancel_will', {
      will_id: BigInt(willId),
      owner,
    });
    return { txHash, refundAmount: will.balance };
  }

  /** Replaces the beneficiary list for a will before it has been triggered. */
  async updateBeneficiaries(params: UpdateBeneficiariesParams): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
    const { txHash } = await this.invoke('update_beneficiaries', {
      will_id: BigInt(params.willId),
      owner,
      beneficiaries: params.beneficiaries,
    });
    return { txHash };
  }

  /** Adds more of the will's token to its locked balance. */
  async topUp(willId: string, amount: string): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
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
  async getWillsByOwner(owner: string): Promise<Will[]>;
  async getWillsByOwner(owner: string, pagination: PaginationOptions): Promise<PaginatedWillsResult>;
  async getWillsByOwner(
    owner: string,
    pagination?: PaginationOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const raw = await this.read<RawWill[]>('get_wills_by_owner', { owner });
    return paginateWills(raw.map(mapWill), pagination);
  }

  /** Lists every will `beneficiary` is named in. Does not require a connected wallet. */
  async getWillsByBeneficiary(beneficiary: string): Promise<Will[]>;
  async getWillsByBeneficiary(
    beneficiary: string,
    pagination: PaginationOptions,
  ): Promise<PaginatedWillsResult>;
  async getWillsByBeneficiary(
    beneficiary: string,
    pagination?: PaginationOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const raw = await this.read<RawWill[]>('get_wills_by_beneficiary', { beneficiary });
    return paginateWills(raw.map(mapWill), pagination);
  }

  /**
   * Casts a guardian vote to force an early release of `willId`. Once 2 of
   * the will's guardians have voted, the balance is released automatically.
   */
  async guardianTrigger(willId: string): Promise<{ txHash: string }> {
    const guardian = await getPublicKey();
    const { txHash } = await this.invoke('guardian_trigger', {
      will_id: BigInt(willId),
      guardian,
    });
    return { txHash };
  }

  /**
   * Simulates a state-changing contract call and returns the estimated Soroban
   * resource fee without signing or submitting the transaction.
   */
  async previewFee(method: string, params: Record<string, unknown>): Promise<{ resourceFee: string }> {
    const sourceAccount = await getPublicKey();
    const simulation = await this.simulate(method, params, sourceAccount);
    return { resourceFee: this.extractResourceFee(simulation) };
  }

  /**
   * Subscribes to SoroWill contract events using either WebSocket streaming
   * or polling. In `auto` mode, WebSocket is attempted first and polling is
   * used as a fallback if the endpoint does not support streaming.
   */
  async subscribeToEvents(
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions = {},
  ): Promise<EventSubscription> {
    const transport = options.transport ?? 'auto';
    if (transport === 'polling') {
      return this.createPollingSubscription(onEvent, options);
    }

    try {
      return await this.createWebSocketSubscription(onEvent, options);
    } catch (error) {
      if (transport === 'websocket') {
        throw error;
      }
      options.onError?.(new Error(`WebSocket event streaming unavailable; falling back to polling: ${asError(error).message}`));
      return this.createPollingSubscription(onEvent, options);
    }
  }

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(): Promise<InstanceType<typeof Spec>> {
    if (!this.specPromise) {
      this.specPromise = this.server
        .getContractWasmByContractId(this.contract.contractId())
        .then((wasm) => Spec.fromWasm(wasm));
    }
    return this.specPromise;
  }

  /** Simulates a read-only contract call, requiring no connected wallet or signature. */
  private async read<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const spec = await this.getSpec();
    const simulation = await this.simulate(method, args, NULL_ACCOUNT);
    if (!simulation.result) {
      throw new Error(`SoroWill simulation for ${method} returned no result`);
    }
    return spec.funcResToNative(method, simulation.result.retval) as T;
  }

  private async simulate(
    method: string,
    args: Record<string, unknown>,
    sourceAccount: string,
  ): Promise<SimulatedCallResult> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);
    const account =
      sourceAccount === NULL_ACCOUNT ? new Account(NULL_ACCOUNT, '0') : await this.server.getAccount(sourceAccount);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`SoroWill simulation failed for ${method}: ${simulation.error}`);
    }

    return simulation as SimulatedCallResult;
  }

  /** Builds, simulates, signs, and submits a state-changing contract call. */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const publicKey = await getPublicKey();
    const account = await this.server.getAccount(publicKey);
    const builtTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(builtTx);
    const signedTxXdr = await signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;

    const sendResponse = await this.server.sendTransaction(signedTx);
    if (sendResponse.status === 'ERROR') {
      throw new Error(`SoroWill transaction submission failed for ${method}`);
    }

    const txResponse = await this.server.pollTransaction(sendResponse.hash, { attempts: 30 });
    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`SoroWill transaction for ${method} did not succeed: ${txResponse.status}`);
    }

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  private async createPollingSubscription(
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const interval = normalizePositiveInteger(options.pollIntervalMs, 'pollIntervalMs') ?? this.defaultPollIntervalMs;
    const pageSize = normalizePositiveInteger(options.pageSize, 'pageSize') ?? 100;
    let cursor = options.cursor ?? null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      if (closed) {
        return;
      }

      try {
        const page = await this.fetchEventsPage(cursor, pageSize);
        for (const event of page.events) {
          await onEvent(event);
          cursor = event.cursor;
        }
        if (page.nextCursor) {
          cursor = page.nextCursor;
        }
      } catch (error) {
        options.onError?.(asError(error));
      } finally {
        if (!closed) {
          timer = setTimeout(() => {
            void poll();
          }, interval);
        }
      }
    };

    void poll();

    return {
      transport: 'polling',
      get closed() {
        return closed;
      },
      close() {
        closed = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      },
    };
  }

  private async createWebSocketSubscription(
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const pageSize = normalizePositiveInteger(options.pageSize, 'pageSize') ?? 100;
    const socket = await this.openWebSocket(this.eventStreamUrl);
    let closed = false;

    socket.onmessage = (message) => {
      void this.handleStreamMessage(message.data, onEvent, options);
    };
    socket.onerror = () => {
      options.onError?.(new Error('SoroWill event stream connection error'));
    };
    socket.onclose = () => {
      closed = true;
    };
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscribeToEvents',
        params: this.buildEventRequestParams(options.cursor ?? null, pageSize),
      }),
    );

    return {
      transport: 'websocket',
      get closed() {
        return closed;
      },
      close() {
        closed = true;
        socket.close();
      },
    };
  }

  private async handleStreamMessage(
    data: string,
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions,
  ): Promise<void> {
    try {
      const parsed = JSON.parse(data) as JsonRpcSuccess<RpcEventPage | RpcEventRecord[]> | JsonRpcFailure | RpcEventPage;
      if ('error' in parsed) {
        throw new Error(parsed.error.message ?? 'Unknown event stream error');
      }

      const page = this.normalizeEventPage('result' in parsed ? parsed.result : parsed);
      for (const event of page.events) {
        await onEvent(event);
      }
    } catch (error) {
      options.onError?.(asError(error));
    }
  }

  private async fetchEventsPage(cursor: string | null, pageSize: number): Promise<{
    events: SoroWillEvent[];
    nextCursor: string | null;
  }> {
    const fetchImplementation = this.fetchImplementation ?? globalThis.fetch;
    if (!fetchImplementation) {
      throw new Error('No fetch implementation is available for event polling');
    }

    const response = await fetchImplementation(this.eventRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getEvents',
        params: this.buildEventRequestParams(cursor, pageSize),
      }),
    });

    const json = (await response.json()) as JsonRpcSuccess<RpcEventPage | RpcEventRecord[]> | JsonRpcFailure;
    if ('error' in json) {
      throw new Error(json.error.message ?? 'Unknown RPC error while fetching events');
    }

    return this.normalizeEventPage(json.result);
  }

  private normalizeEventPage(payload: RpcEventPage | RpcEventRecord[]): {
    events: SoroWillEvent[];
    nextCursor: string | null;
  } {
    const records = Array.isArray(payload) ? payload : (payload.events ?? []);
    const events = records.map((record) => mapEventRecord(record, this.contract.contractId()));
    const nextCursor =
      Array.isArray(payload)
        ? (events.length > 0 ? events[events.length - 1]?.cursor ?? null : null)
        : (payload.nextCursor ?? (events.length > 0 ? events[events.length - 1]?.cursor ?? null : null));

    return {
      events,
      nextCursor,
    };
  }

  private buildEventRequestParams(cursor: string | null, limit: number): Record<string, unknown> {
    return {
      filters: [
        {
          type: 'contract',
          contractIds: [this.contract.contractId()],
        },
      ],
      pagination: {
        cursor,
        limit,
      },
    };
  }

  private deriveDefaultEventStreamUrl(rpcUrl: string): string {
    const url = new URL(rpcUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/events`;
    return url.toString();
  }

  private async openWebSocket(url: string): Promise<WebSocketLike> {
    const socket = this.webSocketFactory ? this.webSocketFactory(url) : this.createBrowserWebSocket(url);
    return new Promise<WebSocketLike>((resolve, reject) => {
      let settled = false;

      socket.onopen = () => {
        settled = true;
        resolve(socket);
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`Unable to open SoroWill event stream at ${url}`));
        }
      };
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`SoroWill event stream closed before it was ready at ${url}`));
        }
      };
    });
  }

  private createBrowserWebSocket(url: string): WebSocketLike {
    if (typeof WebSocket === 'undefined') {
      throw new Error('No WebSocket implementation is available for event streaming');
    }
    return new WebSocket(url) as unknown as WebSocketLike;
  }

  private extractResourceFee(simulation: SimulatedCallResult): string {
    if (!simulation.minResourceFee) {
      throw new Error('Soroban simulation did not return a minResourceFee estimate');
    }
    return simulation.minResourceFee;
  }
}
