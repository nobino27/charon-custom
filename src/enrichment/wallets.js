import { existsSync, readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { SAVED_WALLETS_PATH } from '../config.js';
import { db } from '../db/connection.js';
import { now } from '../utils.js';

function parseWalletRows(raw) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.wallets)) return parsed.wallets;
  throw new Error('saved wallets JSON must be an array or { "wallets": [...] }');
}

function normalizeWalletRow(row, index) {
  const label = String(row?.label || '').trim();
  const address = String(row?.address || '').trim();
  const source = String(row?.source || '').trim() || null;
  if (!label) throw new Error(`wallet #${index + 1} missing label`);
  if (!address) throw new Error(`wallet ${label} missing address`);
  try {
    new PublicKey(address);
  } catch {
    throw new Error(`wallet ${label} has invalid Solana address`);
  }
  return { label, address, source };
}

export function initSavedWallets(filePath = SAVED_WALLETS_PATH) {
  if (!filePath || !existsSync(filePath)) return;
  const rows = parseWalletRows(readFileSync(filePath, 'utf8'));
  const skipped = [];
  const wallets = rows.map((row, index) => {
    try {
      return normalizeWalletRow(row, index);
    } catch (err) {
      skipped.push(err.message);
      return null;
    }
  }).filter(Boolean);
  const sync = db.transaction(() => {
    const removeAddressConflict = db.prepare('DELETE FROM saved_wallets WHERE address = ? AND label != ?');
    const upsert = db.prepare(`
      INSERT INTO saved_wallets (label, address, source, created_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET
        address = excluded.address,
        source = excluded.source
    `);
    for (const wallet of wallets) {
      removeAddressConflict.run(wallet.address, wallet.label);
      upsert.run(wallet.label, wallet.address, wallet.source, now());
    }
  });
  sync();
  for (const message of skipped) console.log(`[wallets] skipped ${message}`);
  if (wallets.length || skipped.length) {
    console.log(`[wallets] initialized ${wallets.length} saved wallets from ${filePath}${skipped.length ? `, skipped ${skipped.length}` : ''}`);
  }
}

export function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}

export async function fetchSavedWalletExposure(mint, holders) {
  const wallets = savedWallets();
  if (!wallets.length || !holders?.holders?.length) {
    return { holderCount: 0, checked: wallets.length, wallets: [] };
  }
  const holderSet = new Set(holders.holders.map(h => h.address));
  const matched = wallets.filter(wallet => holderSet.has(wallet.address));
  return {
    holderCount: matched.length,
    checked: wallets.length,
    wallets: matched.map(w => w.label),
  };
}

export async function fetchWalletPnl(address) {
  try {
    const url = `https://datapi.jup.ag/v1/pnl?addresses=${encodeURIComponent(address)}&includeClosed=false`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.[address] ?? data?.data?.[address] ?? data;
    if (!d || typeof d !== 'object') return null;
    return {
      totalTrades: Number(d.totalTrades ?? d.total_trades ?? 0),
      wins: Number(d.wins ?? d.winCount ?? d.win_count ?? 0),
      winRate: Number(d.winRate ?? d.win_rate ?? 0),
      totalPnlPercent: Number(d.totalPnlPercent ?? d.total_pnl_percent ?? d.totalPnlUsd ?? 0),
    };
  } catch {
    return null;
  }
}
