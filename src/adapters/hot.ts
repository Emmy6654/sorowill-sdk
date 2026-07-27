import { InjectedWalletAdapter, type InjectedWalletProvider } from './injected';

/**
 * Adapter for a HOT Wallet Stellar provider.
 *
 * The provider is injected because HOT can be hosted in several environments
 * (web, Telegram mini-app, or mobile webview).
 */
export class HotWalletAdapter extends InjectedWalletAdapter {
  readonly id = 'hot';
  readonly name = 'HOT Wallet';

  constructor(provider: InjectedWalletProvider) {
    super(provider);
  }
}

