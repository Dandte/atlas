// ═══════════════════════════════════════
// ATLAS — Skill: Crypto Prices
// CoinGecko free API (no key needed)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';

const COIN_IDS: Record<string, string> = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  usdt: 'tether', tether: 'tether',
  bnb: 'binancecoin', binance: 'binancecoin',
  sol: 'solana', solana: 'solana',
  xrp: 'ripple', ripple: 'ripple',
  ada: 'cardano', cardano: 'cardano',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  dot: 'polkadot', polkadot: 'polkadot',
  matic: 'matic-network', polygon: 'matic-network',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  link: 'chainlink', chainlink: 'chainlink',
  ltc: 'litecoin', litecoin: 'litecoin',
};

export class CryptoPricesTool implements Tool {
  definition = {
    name: 'crypto_prices',
    description:
      'Consultar precios de criptomonedas en tiempo real. Bitcoin, Ethereum, Solana, etc. ' +
      'Muestra precio en USD y COP, cambio 24h, market cap. ' +
      'Usar cuando pregunten "precio del bitcoin", "cómo está crypto", "ETH price", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        coins: {
          type: 'string',
          description: 'Criptomoneda(s) separadas por coma. Ej: "btc", "btc,eth,sol". Default: btc,eth',
        },
        currency: {
          type: 'string',
          description: 'Moneda para mostrar precios: "usd", "cop". Default: muestra ambas',
        },
      },
      required: [],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const coinsInput = String(params.coins || 'btc,eth');
    const coinNames = coinsInput.split(',').map(c => c.trim().toLowerCase());

    // Resolve coin IDs
    const ids = coinNames
      .map(name => COIN_IDS[name] || name)
      .filter(Boolean);

    if (ids.length === 0) {
      return { success: false, output: '', error: 'No reconocí ninguna criptomoneda.' };
    }

    try {
      const idsParam = ids.join(',');
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idsParam}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });

      if (!resp.ok) {
        return { success: false, output: '', error: `CoinGecko API error: ${resp.status}` };
      }

      const data = await resp.json() as any[];
      if (!Array.isArray(data) || data.length === 0) {
        return { success: false, output: '', error: 'No encontré datos para esas criptomonedas.' };
      }

      // Get USD→COP rate for conversion
      let copRate = 4200; // fallback
      try {
        const fxResp = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(5000) });
        const fxData = await fxResp.json() as any;
        if (fxData.rates?.COP) copRate = fxData.rates.COP;
      } catch {
        // Use fallback rate
      }

      const lines: string[] = [];
      for (const coin of data) {
        const symbol = (coin.symbol as string).toUpperCase();
        const priceUsd = coin.current_price as number;
        const priceCop = priceUsd * copRate;
        const change24h = coin.price_change_percentage_24h as number;
        const mcap = coin.market_cap as number;

        const arrow = change24h >= 0 ? '↑' : '↓';
        const changeStr = `${arrow} ${Math.abs(change24h).toFixed(1)}%`;

        lines.push(
          `${coin.name} (${symbol})\n` +
          `  USD: $${this.fmt(priceUsd)} | COP: $${this.fmt(priceCop)}\n` +
          `  24h: ${changeStr} | Cap: $${this.fmtCompact(mcap)}`
        );
      }

      return { success: true, output: lines.join('\n\n') };
    } catch (err: any) {
      return { success: false, output: '', error: `Error consultando precios: ${err.message}` };
    }
  }

  private fmt(n: number): string {
    if (n >= 1) {
      return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }

  private fmtCompact(n: number): string {
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    return n.toLocaleString('en-US');
  }
}
