import { InjectedWalletAdapter, type InjectedWalletProvider } from './injected';

/**
 * Adapter for Hana Wallet's injected Stellar provider.
 *
 * Pass the provider explicitly so applications can select the correct Hana
 * account/provider and tests do not depend on a browser global.
 */
export class HanaWalletAdapter extends InjectedWalletAdapter {
  readonly id = 'hana';
  readonly name = 'Hana Wallet';

  constructor(provider: InjectedWalletProvider) {
    super(provider);
  }
}

