import albedo from '@albedo-link/intent';
import type { StellarNetwork } from '@albedo-link/intent';
import { Networks } from '@stellar/stellar-sdk';

/** Result of a successful {@link connectAlbedo} call. */
export interface AlbedoWalletConnection {
  publicKey: string;
  network: StellarNetwork;
  networkPassphrase: string;
}

/**
 * Maps a Stellar network passphrase to the Albedo network identifier string.
 * Albedo uses `'public'` or `'testnet'`; anything else is treated as a private
 * network and the raw passphrase is passed through.
 */
function passphraseToAlbedoNetwork(networkPassphrase: string): string {
  if (networkPassphrase === Networks.PUBLIC) return 'public';
  if (networkPassphrase === Networks.TESTNET) return 'testnet';
  // Custom / private networks: Albedo also accepts raw passphrases for network.
  return networkPassphrase;
}

/**
 * Maps an Albedo network identifier back to a standard Stellar network
 * passphrase.
 */
function albedoNetworkToPassphrase(network: string): string {
  if (network === 'public') return Networks.PUBLIC;
  if (network === 'testnet') return Networks.TESTNET;
  return network;
}

// Module-level state: stored after a successful connectAlbedo() call so that
// getAlbedoPublicKey() can return the key without triggering a second popup.
let _connectedPublicKey: string | undefined;
let _connectedNetwork: StellarNetwork | undefined;

/**
 * Opens the Albedo popup to request the user's public key and establishes a
 * wallet connection. Must be called before {@link getAlbedoPublicKey} or
 * {@link signAlbedoTransaction}.
 *
 * @throws if the user cancels the Albedo popup or an error occurs.
 */
export async function connectAlbedo(): Promise<AlbedoWalletConnection> {
  const result = await albedo.publicKey({});

  // Albedo's publicKey intent does not return network info, so we infer it from
  // any previously stored connection or default to testnet for safety. A
  // caller that needs a specific network should use connectAlbedoWithNetwork().
  const network: StellarNetwork = _connectedNetwork ?? 'testnet';
  const networkPassphrase = albedoNetworkToPassphrase(network);

  _connectedPublicKey = result.pubkey;
  _connectedNetwork = network;

  return {
    publicKey: result.pubkey,
    network,
    networkPassphrase,
  };
}

/**
 * Opens the Albedo popup to request the user's public key, explicitly setting
 * the target Stellar network.
 *
 * @param networkPassphrase - Full Stellar network passphrase (e.g. `Networks.TESTNET`).
 * @throws if the user cancels the Albedo popup or an error occurs.
 */
export async function connectAlbedoWithNetwork(
  networkPassphrase: string,
): Promise<AlbedoWalletConnection> {
  const result = await albedo.publicKey({});

  const albedoNetwork = passphraseToAlbedoNetwork(networkPassphrase);
  // Only 'public' and 'testnet' are valid StellarNetwork literals; default to
  // treating custom networks as testnet for the typed field.
  const network: StellarNetwork =
    albedoNetwork === 'public' || albedoNetwork === 'testnet'
      ? albedoNetwork
      : 'testnet';

  _connectedPublicKey = result.pubkey;
  _connectedNetwork = network;

  return {
    publicKey: result.pubkey,
    network,
    networkPassphrase,
  };
}

/**
 * Returns the public key stored from the most recent successful
 * {@link connectAlbedo} / {@link connectAlbedoWithNetwork} call, without
 * opening a new popup.
 *
 * @throws if {@link connectAlbedo} has not been called yet in this session.
 */
export async function getAlbedoPublicKey(): Promise<string> {
  if (!_connectedPublicKey) {
    throw new Error(
      'No Albedo account is connected. Call connectAlbedo() first.',
    );
  }
  return _connectedPublicKey;
}

/**
 * Asks Albedo to sign a transaction XDR envelope, returning the signed XDR.
 * Requires {@link connectAlbedo} to have been called first so that the pubkey
 * and network are known.
 *
 * @param transactionXdr - XDR-encoded transaction envelope to sign.
 * @param opts.networkPassphrase - Stellar network passphrase for the transaction.
 * @throws if the user cancels the signing popup or Albedo reports an error.
 */
export async function signAlbedoTransaction(
  transactionXdr: string,
  opts: { networkPassphrase: string },
): Promise<string> {
  const network = passphraseToAlbedoNetwork(opts.networkPassphrase);

  // Build params conditionally to satisfy exactOptionalPropertyTypes: if
  // pubkey is undefined we omit the property entirely rather than passing
  // `undefined`, which would violate the strict optional-property check.
  const txParams = _connectedPublicKey
    ? { xdr: transactionXdr, pubkey: _connectedPublicKey, network }
    : { xdr: transactionXdr, network };

  const result = await albedo.tx(txParams);

  return result.signed_envelope_xdr;
}

/**
 * Resets the stored connection state. Useful in tests or when the user
 * explicitly disconnects.
 *
 * @internal
 */
export function _resetAlbedoConnection(): void {
  _connectedPublicKey = undefined;
  _connectedNetwork = undefined;
}
