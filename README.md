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
});

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
| `getWill` | Reads the full state of a will (no wallet required) | `willId` | `Promise<Will>` |
| `getWillsByOwner` | Lists every will owned by an address (no wallet required) | `owner` | `Promise<Will[]>` |
| `getWillsByBeneficiary` | Lists every will an address is named in (no wallet required) | `beneficiary` | `Promise<Will[]>` |
| `guardianTrigger` | Casts a guardian vote; 2 of 3 forces an early release | `willId` | `Promise<{ txHash }>` |

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

## Wallet adapters

All adapters implement `WalletAdapter`, whose `connect`, `disconnect`,
`isConnected`, `getPublicKey`, and `signTransaction` methods make it possible
to switch wallets without changing application transaction code.

```ts
import { HanaWalletAdapter, HotWalletAdapter } from '@sorowill/sdk';

const hana = new HanaWalletAdapter(hanaProvider);
const hot = new HotWalletAdapter(hotProvider);
const connection = await hana.connect();
```

Hana and HOT accept injected providers. Explicit injection supports browser
extensions, embedded webviews, and mini-app environments while keeping wallet
permissions under the host application's control.

### Pairing LOBSTR

LOBSTR is primarily a mobile wallet, so `LobstrWalletAdapter` accepts a
WalletConnect-compatible session client. Calling `connect()` creates a pairing
and reports its URI through `onPairingUri`; desktop applications should render
that URI as a QR code. Applications may also use `openDeepLink` to open the
generated `lobstr://wallet-connect?uri=...` link on the same mobile device.
`connect()` resolves only after LOBSTR approves the session.

```ts
const lobstr = new LobstrWalletAdapter({
  client: walletConnectSession,
  onPairingUri: (uri) => showQrCode(uri),
  openDeepLink: (link) => window.location.assign(link),
});
await lobstr.connect();
```

### Connecting Ledger

Create a Ledger transport appropriate to the environment (WebUSB, WebHID, or
Node) and pass it to `LedgerWalletAdapter`. The default Stellar derivation path
is `44'/148'/0'`. `signTransaction()` sends the transaction signature base to
the Stellar app and remains pending while the device displays the confirmation
screen; it resolves with signed XDR only after the user physically approves.

```ts
const ledger = new LedgerWalletAdapter({
  transport,
  network: 'testnet',
  networkPassphrase: Networks.TESTNET,
});
await ledger.connect();
const signedXdr = await ledger.signTransaction(unsignedXdr, {
  networkPassphrase: Networks.TESTNET,
});
```

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
