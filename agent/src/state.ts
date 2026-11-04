import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';

export interface SyncState {
  customersAlterId: number;
  productsAlterId: number;
  lastSyncAt?: string;
}

export function loadState(): SyncState {
  if (!existsSync(config.stateFile)) return { customersAlterId: 0, productsAlterId: 0 };
  try {
    return JSON.parse(readFileSync(config.stateFile, 'utf8'));
  } catch {
    return { customersAlterId: 0, productsAlterId: 0 };
  }
}

export function saveState(s: SyncState): void {
  writeFileSync(config.stateFile, JSON.stringify(s, null, 2));
}
