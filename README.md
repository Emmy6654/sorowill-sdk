<img src="./docs/logo.svg" alt="SoroWill" width="56" height="56" />

# @sorowill/sdk

**TypeScript SDK for SoroWill — trustless on-chain inheritance on Stellar Soroban**

[![npm](https://img.shields.io/npm/v/%40sorowill%2Fsdk)](https://www.npmjs.com/package/@sorowill/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Installation

```bash
npm install @sorowill/sdk
```

## Quick Start

```ts
import { SoroWillClient, connectWallet, toStroops } from '@sorowill/sdk';

// Connect the user's Freighter wallet.
const wallet = await connectWallet();

// Point the client at the deployed SoroWill contract on testnet.
const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
  timeoutMs: 15_000,
  maxConcurrentRequests: 4,
  requestsPerSecond: 10,
});

// Or construct from environment variables in Node-based apps:
// SOROWILL_NETWORK=testnet
// SOROWILL_CONTRACT_ID=CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE
// const client = SoroWillClient.fromEnv();

// Create a will locking 1,000 USDC, split 60/40 between two beneficiaries,
// with a 90-day check-in period and a 7-day grace period.
const { willId, txHash } = await client.createWill({
  token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', // testnet USDC SAC
  amount: toStroops('1000').toString(),
  beneficiaries: [
    { address: 'GBEN...AAAA', percentage: 60 },
    { address: 'GBEN...BBBB', percentage: 40 },
  ],
  checkinPeriodDays: 90,
  gracePeriodDays: 7,
  guardians: [],
});

console.log(`Created will #${willId} in tx ${txHash}`);

// Check in periodically to reset the countdown and prove you're still active.
const { nextDeadline } = await client.checkIn(willId);
console.log(`Next check-in due by ${nextDeadline.toISOString()}`);

// Read a will's full state at any time — no wallet required.
const will = await client.getWill(willId);
console.log(will.status, will.balance, will.beneficiaries);
```

## API Reference

| Method | Description | Parameters | Returns |
|---|---|---|---|
| `createWill` | Locks a token balance and creates a new will | `CreateWillParams` | `Promise<{ willId, txHash }>` |
| `checkIn` | Resets the check-in countdown | `willId` | `Promise<{ txHash, nextDeadline }>` |
| `triggerWill` | Starts the grace period after a missed check-in | `willId` | `Promise<{ txHash }>` |
| `emergencyCheckIn` | Cancels an in-progress trigger during the grace period | `willId` | `Promise<{ txHash, nextDeadline }>` |
| `releaseInheritance` | Distributes the balance to beneficiaries after the grace period expires | `willId` | `Promise<{ txHash }>` |
| `cancelWill` | Withdraws the full balance and closes the will | `willId` | `Promise<{ txHash, refundAmount }>` |
| `updateBeneficiaries` | Replaces the beneficiary list before the will is triggered | `UpdateBeneficiariesParams` | `Promise<{ txHash }>` |
| `topUp` | Adds more of the token to an existing will | `willId`, `amount` | `Promise<{ txHash }>` |
| `previewFee` | Simulates a state-changing method and returns its estimated Soroban resource fee | `method`, `params` | `Promise<{ resourceFee }>` |
| `getWill` | Reads the full state of a will (no wallet required) | `willId` | `Promise<Will>` |
| `getWillsByOwner` | Lists every will owned by an address, with optional client-side pagination | `owner`, `PaginationOptions?` | `Promise<Will[] \| { wills, nextCursor }>` |
| `getWillsByBeneficiary` | Lists every will an address is named in, with optional client-side pagination | `beneficiary`, `PaginationOptions?` | `Promise<Will[] \| { wills, nextCursor }>` |
| `guardianTrigger` | Casts a guardian vote; 2 of 3 forces an early release | `willId` | `Promise<{ txHash }>` |
| `batch` | Simulates, signs, and submits multiple contract operations atomically | `BatchOperation[]` | `Promise<BatchResult>` |

Every method also accepts an optional final `{ timeoutMs }` argument. RPC work flows through a
shared FIFO queue configured by `maxConcurrentRequests` and `requestsPerSecond`, preventing bursts
of reads or writes from overwhelming a public endpoint. A timeout rejects with
`RequestTimeoutError`.

## Batch transactions

`batch` combines native contract calls into one Stellar transaction and therefore one Freighter
signature prompt:

```ts
const result = await client.batch([
  {
    method: 'create_will',
    args: {
      owner: wallet.publicKey,
      token: 'CBIEL...DAMA',
      amount: 10_000_000n,
      beneficiaries: [{ address: 'GBEN...AAAA', percentage: 100 }],
      checkin_period_days: 90n,
      grace_period_days: 7n,
      guardians: [],
    },
  },
  {
    method: 'check_in',
    args: { will_id: 1n, owner: wallet.publicKey },
  },
]);
```

The whole batch is simulated and assembled together, signed once, and submitted atomically.

## Typed errors

Contract failures are exposed as subclasses of `WillContractError`, including
`WillNotFoundError`, `NotOwnerError`, `WillNotActiveError`, `WillNotTriggeredError`,
`GracePeriodNotExpiredError`, `GracePeriodExpiredError`, `InvalidPercentagesError`,
`AlreadyVotedError`, `NotGuardianError`, `CheckinNotDueError`, `ZeroAmountError`, and
`TooManyBeneficiariesError`.

## Utilities

| Function | Description |
|---|---|
| `formatUSDC(stroops)` | Formats base units as a human-readable decimal string, e.g. `"1,234.50"` |
| `toStroops(usdc)` | Parses a decimal USDC string into base units as a `bigint` |
| `getTimeUntilCheckin(will)` | Seconds until the next check-in deadline (negative if overdue) |
| `isCheckinDue(will)` | Whether the check-in deadline has already passed |
| `calculateShares(balance, beneficiaries)` | Splits a balance across beneficiaries, mirroring on-chain rounding |
| `formatDeadline(date)` | Formats a `Date` as a human-readable string |
| `validateBeneficiaries(beneficiaries)` | Checks that percentages are well-formed and sum to 100 |

## Wallet helpers

`isFreighterInstalled()`, `connectWallet()`, `getPublicKey()`, and `signTransaction()` wrap the [Freighter](https://www.freighter.app/) browser extension API used internally by `SoroWillClient` for all state-changing calls.

## Local Setup

```bash
git clone https://github.com/SoroWill/sorowill-sdk.git
cd sorowill-sdk
npm install
npm run typecheck
npm test
npm run build
```

## Contributing via Drips Wave

This repo participates in the **Stellar Wave Program** on [Drips](https://drips.network/wave). Maintainer-tagged issues carry Point values, and contributors who resolve them during an active Wave earn a proportional share of that Wave's reward pool. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow, and <https://drips.network/wave> for how Wave itself works.
