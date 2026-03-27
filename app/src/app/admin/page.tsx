'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import toast from 'react-hot-toast';
import { usePerk } from '@/providers/PerkProvider';
import { useConnection } from '@solana/wallet-adapter-react';
import { sanitizeError } from '@/lib/error-utils';
import {
  ProtocolAccount,
  MarketAccount,
  OracleSource,
  SetFallbackOracleParams,
  UpdateOracleConfigParams,
  AdminUpdateMarketParams,
  PerkOracleAccount,
  LEVERAGE_SCALE,
  MIN_LEVERAGE,
  MAX_LEVERAGE,
  MIN_TRADING_FEE_BPS,
  MAX_TRADING_FEE_BPS,
} from '@perk/sdk';

// ── Constants ──

// Reference only — admin is now fetched on-chain
// const ADMIN_PUBKEY = 'CxtsPjsmDFnjxtX25UWznyB8mgzAsHdFueGspcUM69LX';
const LAMPORTS_PER_SOL = 1_000_000_000;

// ── Helpers ──

function truncatePubkey(key: string): string {
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function lamportsToSol(lamports: BN): string {
  const str = lamports.toString().padStart(10, '0');
  const whole = str.slice(0, -9) || '0';
  const frac = str.slice(-9).replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function oracleSourceLabel(source: OracleSource): string {
  switch (source) {
    case OracleSource.Pyth: return 'Pyth';
    case OracleSource.PerkOracle: return 'PerkOracle';
    case OracleSource.DexPool: return 'DexPool';
    default: return `Unknown(${source})`;
  }
}

// ── Types ──

interface MarketWithAddress {
  address: PublicKey;
  account: MarketAccount;
}

// ── Main Page ──

export default function AdminPage() {
  const { publicKey, connected } = useWallet();
  const { client, readonlyClient } = usePerk();
  const [onChainAdmin, setOnChainAdmin] = useState<string | null>(null);
  const [protocolExists, setProtocolExists] = useState(true);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    readonlyClient.fetchProtocol()
      .then(p => { setOnChainAdmin(p.admin.toBase58()); setProtocolExists(true); })
      .catch(() => { setOnChainAdmin(null); setProtocolExists(false); })
      .finally(() => setChecking(false));
  }, [readonlyClient]);

  if (!connected) return <ConnectWalletScreen />;
  if (checking) return <div className="min-h-screen bg-bg flex items-center justify-center"><div className="font-mono text-sm text-text-secondary animate-pulse">Verifying admin...</div></div>;
  if (!protocolExists) return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="border border-border rounded-[2px] bg-surface p-8 max-w-sm w-full text-center space-y-4">
        <div className="font-mono text-sm text-loss">PROTOCOL NOT INITIALIZED</div>
        <p className="text-sm text-text-secondary font-sans">The protocol account does not exist yet. Deploy and initialize the program first.</p>
      </div>
    </div>
  );
  if (!onChainAdmin || publicKey?.toBase58() !== onChainAdmin) return <UnauthorizedScreen address={publicKey?.toBase58() ?? ''} />;
  // Code-split: AdminDashboard and all its sub-components are only loaded
  // after the wallet is verified as admin. This keeps the heavy admin UI
  // code out of the main bundle for non-admin users.
  return <AdminDashboard client={client} readonlyClient={readonlyClient} />;
}

// Note: AdminDashboard and all child components below are tree-shaken from
// the initial page load. They are only rendered after admin verification.

// ── Screens ──

function ConnectWalletScreen() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="border border-border rounded-[2px] bg-surface p-8 max-w-sm w-full text-center space-y-6">
        <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          PERK ADMIN
        </div>
        <h1 className="font-sans font-semibold text-xl text-white">
          Connect Wallet
        </h1>
        <p className="text-sm text-text-secondary font-sans">
          Admin access requires the protocol admin wallet.
        </p>
        <div className="flex justify-center">
          <WalletMultiButton />
        </div>
      </div>
    </div>
  );
}

function UnauthorizedScreen({ address }: { address: string }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="border border-border rounded-[2px] bg-surface p-8 max-w-sm w-full text-center space-y-4">
        <div className="font-mono text-sm text-loss">UNAUTHORIZED</div>
        <p className="text-sm text-text-secondary font-sans">
          Connected: <span className="font-mono text-white">{truncatePubkey(address)}</span>
        </p>
        <p className="text-xs text-text-tertiary font-sans">
          This wallet is not the protocol admin.
        </p>
        <div className="flex justify-center pt-2">
          <WalletMultiButton />
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ──

function AdminDashboard({
  client,
  readonlyClient,
}: {
  client: ReturnType<typeof usePerk>['client'];
  readonlyClient: ReturnType<typeof usePerk>['readonlyClient'];
}) {
  const { connection } = useConnection();
  const [protocol, setProtocol] = useState<ProtocolAccount | null>(null);
  const [markets, setMarkets] = useState<MarketWithAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMarket, setSelectedMarket] = useState<MarketWithAddress | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [protocolBalance, setProtocolBalance] = useState<number>(0);

  const fetchData = useCallback(async () => {
    try {
      const [proto, mkts] = await Promise.all([
        readonlyClient.fetchProtocol(),
        readonlyClient.fetchAllMarkets(),
      ]);
      setFetchError(false);
      setProtocol(proto);
      setMarkets(mkts);
      setSelectedMarket(prev => {
        if (!prev) return null;
        return mkts.find(m => m.address.equals(prev.address)) ?? null;
      });

      // Fetch actual SOL balance of protocol PDA (includes creation fees)
      try {
        const protocolPDA = readonlyClient.getProtocolAddress();
        const balance = await connection.getBalance(protocolPDA);
        setProtocolBalance(balance / LAMPORTS_PER_SOL);
      } catch { /* ignore */ }
    } catch (err) {
      toast.error(sanitizeError(err, 'admin-fetch'));
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [readonlyClient, connection]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="font-mono text-sm text-text-secondary animate-pulse">
          Loading protocol state...
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="font-mono text-sm text-loss">Failed to fetch protocol data</div>
          <button onClick={fetchData} className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const protocolAddress = readonlyClient.getProtocolAddress().toBase58();

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="border-b border-border px-4 md:px-8 h-14 flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
            PERK ADMIN
          </div>
          <div className="w-px h-4 bg-border" />
          <div className="font-mono text-xs text-profit">● CONNECTED</div>
        </div>
        <WalletMultiButton />
      </div>

      <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 space-y-6">
        {/* Section 1: Protocol Overview */}
        {protocol && (
          <ProtocolOverview
            protocol={protocol}
            protocolAddress={protocolAddress}
            marketCount={markets.length}
            protocolBalance={protocolBalance}
          />
        )}

        {/* Section 2: Protocol Actions */}
        {protocol && client && (
          <ProtocolActions
            client={client}
            protocol={protocol}
            onRefresh={fetchData}
          />
        )}

        {/* Section 3: Markets Table */}
        <MarketsTable
          markets={markets}
          selectedMarket={selectedMarket}
          onSelectMarket={setSelectedMarket}
        />

        {/* Section 4: Market Edit Panel */}
        {selectedMarket && client && (
          <MarketEditPanel
            key={selectedMarket.address.toBase58()}
            client={client}
            market={selectedMarket}
            onRefresh={fetchData}
            onClose={() => setSelectedMarket(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Section 1: Protocol Overview ──

function ProtocolOverview({
  protocol,
  protocolAddress,
  marketCount,
  protocolBalance,
}: {
  protocol: ProtocolAccount;
  protocolAddress: string;
  marketCount: number;
  protocolBalance: number;
}) {
  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border">
        <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          Protocol Overview
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-px bg-border">
        <InfoCell
          label="Protocol PDA"
          value={truncatePubkey(protocolAddress)}
          mono
          copyValue={protocolAddress}
        />
        <InfoCell
          label="Admin"
          value={truncatePubkey(protocol.admin.toBase58())}
          mono
          copyValue={protocol.admin.toBase58()}
        />
        <InfoCell
          label="Status"
          value={protocol.paused ? 'PAUSED' : 'ACTIVE'}
          color={protocol.paused ? 'text-loss' : 'text-profit'}
        />
        <InfoCell label="Markets" value={marketCount.toString()} />
        <InfoCell
          label="Treasury Balance"
          value={`${protocolBalance.toFixed(4)} SOL`}
          mono
          color="text-profit"
        />
        <InfoCell
          label="Trading Fees"
          value={`${lamportsToSol(protocol.totalFeesCollected)} SOL`}
          mono
        />
      </div>
    </section>
  );
}

function InfoCell({
  label,
  value,
  mono,
  color,
  copyValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
  copyValue?: string;
}) {
  const handleCopy = async () => {
    if (copyValue) {
      try {
        await navigator.clipboard.writeText(copyValue);
        toast.success('Copied to clipboard');
      } catch {
        toast.error('Copy failed — use Ctrl+C');
      }
    }
  };

  return (
    <div className="bg-surface px-5 py-4">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider mb-1">
        {label}
      </div>
      <div
        className={`text-sm ${mono ? 'font-mono' : 'font-sans font-medium'} ${color ?? 'text-white'} ${copyValue ? 'cursor-pointer hover:text-text-secondary transition-colors' : ''}`}
        onClick={copyValue ? handleCopy : undefined}
        title={copyValue ? `Click to copy: ${copyValue}` : undefined}
      >
        {value}
      </div>
    </div>
  );
}

// ── Section 2: Protocol Actions ──

function ProtocolActions({
  client,
  protocol,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  protocol: ProtocolAccount;
  onRefresh: () => Promise<void>;
}) {
  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border">
        <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          Protocol Actions
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
        <PauseToggle client={client} paused={protocol.paused} onRefresh={onRefresh} />
        <WithdrawSol client={client} onRefresh={onRefresh} />
        <div className="md:col-span-2">
          <InitPerkOracle client={client} onRefresh={onRefresh} />
        </div>
        <div className="md:col-span-2">
          <UnfreezeAllOracles client={client} onRefresh={onRefresh} />
        </div>
        <div className="md:col-span-2">
          <TransferAdmin client={client} onRefresh={onRefresh} />
        </div>
      </div>
    </section>
  );
}

function PauseToggle({
  client,
  paused,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  paused: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleToggle = async () => {
    if (submittingRef.current) return;
    if (!confirm(`${paused ? 'Unpause' : 'Pause'} the entire protocol? ${paused ? '' : 'All trading will stop.'}`)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const sig = await client.adminPause(!paused);
      toast.success(`Protocol ${paused ? 'unpaused' : 'paused'} — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Pause / Unpause
      </div>
      <p className="text-xs text-text-secondary font-sans">
        Currently: <span className={paused ? 'text-loss' : 'text-profit'}>{paused ? 'PAUSED' : 'ACTIVE'}</span>
      </p>
      <button
        onClick={handleToggle}
        disabled={submitting}
        className={`font-mono text-xs px-4 py-2 rounded-[2px] border transition-colors disabled:opacity-50 ${
          paused
            ? 'border-profit/30 text-profit hover:bg-profit/10'
            : 'border-loss/30 text-loss hover:bg-loss/10'
        }`}
      >
        {submitting ? 'Submitting...' : paused ? 'Unpause Protocol' : 'Pause Protocol'}
      </button>
    </div>
  );
}

function WithdrawSol({
  client,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  onRefresh: () => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleWithdraw = async () => {
    if (submittingRef.current) return;
    // Strict decimal validation — reject scientific notation, negative, non-numeric
    if (!/^\d+(\.\d{1,9})?$/.test(amount.trim())) {
      toast.error('Enter a valid SOL amount (e.g. 1.5)');
      return;
    }
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      toast.error('Enter a valid SOL amount');
      return;
    }
    if (!confirm(`Withdraw ${amount} SOL from the protocol?`)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const [whole, frac = ''] = amount.trim().split('.');
      const padded = (frac + '000000000').slice(0, 9);
      const lamports = new BN(whole + padded);
      if (lamports.isZero()) {
        toast.error('Amount too small');
        return;
      }
      const sig = await client.adminWithdrawSol(lamports);
      toast.success(`Withdrew ${amount} SOL — ${truncatePubkey(sig)}`);
      setAmount('');
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Withdraw SOL
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          step="0.001"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleWithdraw}
          disabled={submitting || !amount}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Withdraw'}
        </button>
      </div>
    </div>
  );
}

function TransferAdmin({
  client,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  onRefresh: () => Promise<void>;
}) {
  const [newAdmin, setNewAdmin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleTransfer = async () => {
    if (submittingRef.current) return;
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(newAdmin);
    } catch {
      toast.error('Invalid public key');
      return;
    }
    if (!confirm(`Propose ${truncatePubkey(newAdmin)} as new admin? This begins the admin transfer process.`)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const sig = await client.proposeAdmin(pubkey);
      toast.success(`Proposed new admin — ${truncatePubkey(sig)}`);
      setNewAdmin('');
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Transfer Admin
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={newAdmin}
          onChange={(e) => setNewAdmin(e.target.value)}
          placeholder="New admin pubkey"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleTransfer}
          disabled={submitting || !newAdmin}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-loss/30 text-loss hover:bg-loss/10 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Propose'}
        </button>
      </div>
      <p className="text-xs text-text-tertiary font-sans">
        Two-step: propose here, then new admin calls acceptAdmin.
      </p>
    </div>
  );
}

// ── Init PerkOracle ──

const CRANKER_PUBKEY = '99mUUwVBvCD1pLP7fk5z7xPuBoGpyuUGpyTBhW53yw99';

// Top Solana tokens by market cap — batch init all at once
const TOKEN_LIST: { label: string; mint: string }[] = [
  { label: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
  { label: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { label: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { label: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { label: 'JTO', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { label: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { label: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { label: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { label: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { label: 'ORCA', mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
  { label: 'RNDR', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof' },
  { label: 'HNT', mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux' },
  { label: 'TENSOR', mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6' },
  { label: 'W', mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ' },
  { label: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { label: 'MEW', mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' },
  { label: 'PENGU', mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv' },
  { label: 'AI16Z', mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC' },
  { label: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
  { label: 'TRUMP', mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN' },
];

function InitPerkOracle({
  client,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  onRefresh: () => Promise<void>;
}) {
  const [customMint, setCustomMint] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const [existingOracles, setExistingOracles] = useState<Set<string>>(new Set());
  const [checkingExisting, setCheckingExisting] = useState(true);
  const submittingRef = useRef(false);

  // Check which oracles already exist on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = new Set<string>();
      for (const t of TOKEN_LIST) {
        try {
          const oracle = await client.fetchPerkOracleNullable(new PublicKey(t.mint));
          if (oracle) existing.add(t.mint);
        } catch { /* skip */ }
      }
      if (!cancelled) {
        setExistingOracles(existing);
        setCheckingExisting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const remaining = TOKEN_LIST.filter(t => !existingOracles.has(t.mint));

  const initSingle = async (mintStr: string) => {
    if (submittingRef.current) return;
    // Validate mint address
    try { new PublicKey(mintStr); } catch {
      toast.error('Invalid token mint address');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const tokenMint = new PublicKey(mintStr);
      const sig = await client.initializePerkOracle(
        tokenMint,
        new PublicKey(CRANKER_PUBKEY),
        {
          minSources: 2,
          maxStalenessSeconds: 120,
          maxPriceChangeBps: 0,
          circuitBreakerDeviationBps: 0,
        },
      );
      toast.success(`Oracle initialized — ${truncatePubkey(sig)}`);
      setExistingOracles(prev => new Set([...prev, mintStr]));
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const batchInitAll = async () => {
    if (submittingRef.current) return;
    if (remaining.length === 0) {
      toast.success('All oracles already initialized!');
      return;
    }
    if (!confirm(`Initialize ${remaining.length} PerkOracles?\nYou'll approve ${remaining.length} transactions in Phantom.`)) return;
    submittingRef.current = true;
    setSubmitting(true);
    let success = 0;
    let failed = 0;
    for (const t of remaining) {
      setBatchProgress(`${t.label} (${success + failed + 1}/${remaining.length})`);
      try {
        const tokenMint = new PublicKey(t.mint);
        await client.initializePerkOracle(
          tokenMint,
          new PublicKey(CRANKER_PUBKEY),
          {
            minSources: 2,
            maxStalenessSeconds: 120,
            maxPriceChangeBps: 0,
            circuitBreakerDeviationBps: 0,
          },
        );
        success++;
        setExistingOracles(prev => new Set([...prev, t.mint]));
      } catch (err) {
        failed++;
        toast.error(`${t.label}: ${sanitizeError(err, 'admin')}`);
      }
    }
    setBatchProgress('');
    toast.success(`Done: ${success} initialized, ${failed} failed`);
    setSubmitting(false);
    submittingRef.current = false;
    await onRefresh();
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Init PerkOracles
      </div>

      {checkingExisting ? (
        <p className="text-xs text-text-secondary font-sans animate-pulse">Checking existing oracles...</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary font-sans">
              {existingOracles.size}/{TOKEN_LIST.length} initialized
            </span>
            <button
              onClick={batchInitAll}
              disabled={submitting || remaining.length === 0}
              className="font-mono text-xs px-3 py-1.5 rounded-[2px] border border-profit/30 text-profit hover:bg-profit/10 transition-colors disabled:opacity-50"
            >
              {submitting && batchProgress
                ? batchProgress
                : remaining.length === 0
                  ? 'All Done ✓'
                  : `Init All (${remaining.length})`}
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {TOKEN_LIST.map(t => {
              const exists = existingOracles.has(t.mint);
              return (
                <button
                  key={t.mint}
                  onClick={() => !exists && initSingle(t.mint)}
                  disabled={submitting || exists}
                  className={`font-mono text-xs px-2 py-1 rounded-[2px] border transition-colors ${
                    exists
                      ? 'border-profit/20 text-profit/50 cursor-default'
                      : 'border-border text-text-secondary hover:text-white hover:bg-white/5'
                  }`}
                  title={exists ? 'Already initialized' : `Init oracle for ${t.label}`}
                >
                  {exists ? `✓ ${t.label}` : t.label}
                </button>
              );
            })}
          </div>

          {/* Custom mint */}
          <div className="flex gap-2 pt-1">
            <input
              type="text"
              value={customMint}
              onChange={(e) => setCustomMint(e.target.value)}
              placeholder="Custom token mint"
              className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
            />
            <button
              onClick={() => customMint && initSingle(customMint)}
              disabled={submitting || !customMint}
              className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              Init
            </button>
          </div>
        </>
      )}

      <p className="text-xs text-text-tertiary font-sans">
        Cranker: {truncatePubkey(CRANKER_PUBKEY)} · v2: permissionless oracle init
      </p>
    </div>
  );
}

// ── Unfreeze All Stale Oracles ──

function UnfreezeAllOracles({
  client,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  onRefresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [frozenCount, setFrozenCount] = useState<number | null>(null);
  const [frozenMints, setFrozenMints] = useState<{ mint: PublicKey; label: string }[]>([]);
  const submittingRef = useRef(false);

  // Discover frozen/stale oracles on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const allOracles = await client.fetchAllPerkOracles();
        const now = Math.floor(Date.now() / 1000);
        const frozen: { mint: PublicKey; label: string }[] = [];
        for (const o of allOracles) {
          const age = now - o.account.timestamp.toNumber();
          const maxStale = o.account.maxStalenessSeconds;
          // Consider frozen if explicitly frozen OR stale beyond 2x maxStaleness
          if (o.account.isFrozen || age > maxStale * 2) {
            const mintStr = o.account.tokenMint.toBase58();
            const token = TOKEN_LIST.find(t => t.mint === mintStr);
            frozen.push({ mint: o.account.tokenMint, label: token?.label ?? mintStr.slice(0, 8) });
          }
        }
        if (!cancelled) {
          setFrozenCount(frozen.length);
          setFrozenMints(frozen);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const unfreezeAll = async () => {
    if (submittingRef.current || frozenMints.length === 0) return;
    if (!confirm(`Unfreeze ${frozenMints.length} oracles? You'll approve ${frozenMints.length} transactions.`)) return;
    submittingRef.current = true;
    setSubmitting(true);
    let success = 0;
    let failed = 0;
    for (const { mint, label } of frozenMints) {
      setProgress(`${label} (${success + failed + 1}/${frozenMints.length})`);
      try {
        await client.freezePerkOracle(mint, false);
        success++;
      } catch (err) {
        failed++;
        toast.error(`${label}: ${sanitizeError(err, 'admin')}`);
      }
    }
    setProgress('');
    toast.success(`Unfrozen: ${success} oracles, ${failed} failed`);
    setSubmitting(false);
    submittingRef.current = false;
    setFrozenCount(0);
    setFrozenMints([]);
    await onRefresh();
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Unfreeze Stale Oracles
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary font-sans">
          {frozenCount === null ? 'Checking...' : `${frozenCount} frozen/stale oracles`}
        </span>
        <button
          onClick={unfreezeAll}
          disabled={submitting || frozenCount === 0 || frozenCount === null}
          className="font-mono text-xs px-3 py-1.5 rounded-[2px] border border-loss/30 text-loss hover:bg-loss/10 transition-colors disabled:opacity-50"
        >
          {submitting && progress ? progress : frozenCount === 0 ? 'All Fresh ✓' : `Unfreeze All (${frozenCount})`}
        </button>
      </div>
      {frozenMints.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {frozenMints.map(f => (
            <span key={f.mint.toBase58()} className="font-mono text-xs px-2 py-1 rounded-[2px] border border-loss/20 text-loss/70">
              {f.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section 3: Markets Table ──

function formatTokenAmount(raw: BN, decimals: number): string {
  if (raw.isZero()) return '0';
  const str = raw.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, -decimals) || '0';
  const frac = str.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
}

// Common collateral mints → label + decimals
const COLLATERAL_META: Record<string, { label: string; decimals: number }> = {
  'So11111111111111111111111111111111111111112': { label: 'SOL', decimals: 9 },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { label: 'USDC', decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { label: 'USDT', decimals: 6 },
};

function getCollateralInfo(mint: string): { label: string; decimals: number } {
  return COLLATERAL_META[mint] ?? { label: mint.slice(0, 6), decimals: 6 };
}

function MarketsTable({
  markets,
  selectedMarket,
  onSelectMarket,
}: {
  markets: MarketWithAddress[];
  selectedMarket: MarketWithAddress | null;
  onSelectMarket: (m: MarketWithAddress | null) => void;
}) {
  // Group claimable fees by collateral token
  const feesByCollateral: Record<string, { label: string; total: number; markets: { mint: string; amount: number }[] }> = {};
  for (const m of markets) {
    const collateralMint = m.account.collateralMint.toBase58();
    const { label, decimals } = getCollateralInfo(collateralMint);
    const rawAmount = m.account.creatorClaimableFees?.toNumber() ?? 0;
    const amount = rawAmount / (10 ** decimals);
    if (!feesByCollateral[collateralMint]) {
      feesByCollateral[collateralMint] = { label, total: 0, markets: [] };
    }
    feesByCollateral[collateralMint].total += amount;
    if (amount > 0) {
      feesByCollateral[collateralMint].markets.push({
        mint: m.account.tokenMint.toBase58(),
        amount,
      });
    }
  }

  const hasClaimable = Object.values(feesByCollateral).some(f => f.total > 0);

  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          Markets ({markets.length})
        </span>
      </div>

      {/* Claimable Fees Summary */}
      {hasClaimable && (
        <div className="px-5 py-3 border-b border-border bg-profit/[0.03]">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-profit uppercase tracking-wider">
              Claimable Fees
            </span>
            <div className="flex flex-wrap gap-3">
              {Object.entries(feesByCollateral).map(([mint, info]) =>
                info.total > 0 ? (
                  <span key={mint} className="font-mono text-sm text-white">
                    {info.total.toFixed(6)} {info.label}
                  </span>
                ) : null
              )}
            </div>
          </div>
          {Object.entries(feesByCollateral).some(([, info]) => info.markets.length > 1) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(feesByCollateral).flatMap(([, info]) =>
                info.markets.map(m => (
                  <span key={m.mint} className="text-xs text-text-secondary font-mono">
                    {truncatePubkey(m.mint)}: {m.amount.toFixed(6)} {info.label}
                  </span>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {markets.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-text-secondary font-sans">
          No markets found
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Mint</Th>
                <Th>Active</Th>
                <Th>Oracle</Th>
                <Th align="right">Max Lev</Th>
                <Th align="right">Fee (bps)</Th>
                <Th align="right">Claimable</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const isSelected = selectedMarket?.address.equals(m.address);
                const collateralMint = m.account.collateralMint.toBase58();
                const { label: collateralLabel, decimals } = getCollateralInfo(collateralMint);
                const claimableRaw = m.account.creatorClaimableFees?.toNumber() ?? 0;
                const claimable = claimableRaw / (10 ** decimals);
                return (
                  <tr
                    key={m.address.toBase58()}
                    className={`border-b border-border/50 transition-colors cursor-pointer ${
                      isSelected ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]'
                    }`}
                    onClick={() => onSelectMarket(isSelected ? null : m)}
                  >
                    <Td mono>{truncatePubkey(m.account.tokenMint.toBase58())}</Td>
                    <Td>
                      <span className={m.account.active ? 'text-profit' : 'text-loss'}>
                        {m.account.active ? 'YES' : 'NO'}
                      </span>
                    </Td>
                    <Td>{oracleSourceLabel(m.account.oracleSource)}</Td>
                    <Td align="right" mono>{m.account.maxLeverage / LEVERAGE_SCALE}x</Td>
                    <Td align="right" mono>{m.account.tradingFeeBps}</Td>
                    <Td align="right" mono>
                      <span className={claimable > 0 ? 'text-profit' : 'text-text-tertiary'}>
                        {claimable > 0 ? `${claimable.toFixed(4)} ${collateralLabel}` : '—'}
                      </span>
                    </Td>
                    <Td align="right">
                      <button
                        className="font-mono text-xs text-text-secondary hover:text-white transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectMarket(isSelected ? null : m);
                        }}
                      >
                        {isSelected ? 'Close' : 'Edit'}
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-5 py-2.5 text-xs font-mono uppercase text-text-tertiary tracking-wider ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  mono,
  align,
}: {
  children?: React.ReactNode;
  mono?: boolean;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={`px-5 py-3 text-sm ${mono ? 'font-mono' : 'font-sans'} text-white ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </td>
  );
}

// ── Section 4: Market Edit Panel ──

function MarketEditPanel({
  client,
  market,
  onRefresh,
  onClose,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const m = market.account;
  const mintStr = m.tokenMint.toBase58();

  return (
    <section className="border border-border rounded-[2px] bg-surface">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
            Edit Market
          </span>
          <span className="font-mono text-xs text-white">{truncatePubkey(mintStr)}</span>
        </div>
        <button
          onClick={onClose}
          className="font-mono text-xs text-text-secondary hover:text-white transition-colors"
        >
          ✕ Close
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border">
        <ToggleActive client={client} market={market} onRefresh={onRefresh} />
        <UpdateFee client={client} market={market} onRefresh={onRefresh} />
        <UpdateMaxLeverage client={client} market={market} onRefresh={onRefresh} />
        <UpdateOracleConfigPanel client={client} market={market} onRefresh={onRefresh} />
        <FreezePerkOracle client={client} market={market} onRefresh={onRefresh} />
        <SetFallbackOraclePanel client={client} market={market} onRefresh={onRefresh} />
      </div>
    </section>
  );
}

function ToggleActive({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const active = market.account.active;

  const handleToggle = async () => {
    if (submittingRef.current) return;
    if (!confirm(`${active ? 'Deactivate' : 'Activate'} this market?`)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const params: AdminUpdateMarketParams = {
        oracleAddress: null,
        active: !active,
        tradingFeeBps: null,
        maxLeverage: null,
      };
      const sig = await client.adminUpdateMarket(market.account.tokenMint, market.account.creator, null, params);
      toast.success(`Market ${active ? 'deactivated' : 'activated'} — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Toggle Active
      </div>
      <p className="text-xs text-text-secondary font-sans">
        Currently: <span className={active ? 'text-profit' : 'text-loss'}>{active ? 'ACTIVE' : 'INACTIVE'}</span>
      </p>
      <button
        onClick={handleToggle}
        disabled={submitting}
        className={`font-mono text-xs px-4 py-2 rounded-[2px] border transition-colors disabled:opacity-50 ${
          active
            ? 'border-loss/30 text-loss hover:bg-loss/10'
            : 'border-profit/30 text-profit hover:bg-profit/10'
        }`}
      >
        {submitting ? 'Submitting...' : active ? 'Deactivate' : 'Activate'}
      </button>
    </div>
  );
}

function UpdateFee({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [feeBps, setFeeBps] = useState(market.account.tradingFeeBps.toString());
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleUpdate = async () => {
    if (submittingRef.current) return;
    const parsed = parseInt(feeBps, 10);
    if (isNaN(parsed) || parsed < MIN_TRADING_FEE_BPS || parsed > MAX_TRADING_FEE_BPS) {
      toast.error(`Fee must be ${MIN_TRADING_FEE_BPS}–${MAX_TRADING_FEE_BPS} bps`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const params: AdminUpdateMarketParams = {
        oracleAddress: null,
        active: null,
        tradingFeeBps: parsed,
        maxLeverage: null,
      };
      const sig = await client.adminUpdateMarket(market.account.tokenMint, market.account.creator, null, params);
      toast.success(`Fee updated to ${parsed} bps — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Trading Fee
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          value={feeBps}
          onChange={(e) => setFeeBps(e.target.value)}
          placeholder="bps"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleUpdate}
          disabled={submitting}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Set'}
        </button>
      </div>
      <p className="text-xs text-text-tertiary font-sans">
        Current: {market.account.tradingFeeBps} bps ({(market.account.tradingFeeBps / 100).toFixed(2)}%)
      </p>
    </div>
  );
}

function UpdateMaxLeverage({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [leverage, setLeverage] = useState((market.account.maxLeverage / LEVERAGE_SCALE).toString());
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleUpdate = async () => {
    if (submittingRef.current) return;
    const parsed = parseInt(leverage, 10);
    if (isNaN(parsed) || parsed * LEVERAGE_SCALE < MIN_LEVERAGE || parsed * LEVERAGE_SCALE > MAX_LEVERAGE) {
      toast.error(`Leverage must be ${MIN_LEVERAGE / LEVERAGE_SCALE}x–${MAX_LEVERAGE / LEVERAGE_SCALE}x`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const params: AdminUpdateMarketParams = {
        oracleAddress: null,
        active: null,
        tradingFeeBps: null,
        maxLeverage: parsed * LEVERAGE_SCALE,
      };
      const sig = await client.adminUpdateMarket(market.account.tokenMint, market.account.creator, null, params);
      toast.success(`Max leverage updated to ${parsed}x — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Max Leverage
      </div>
      <div className="flex gap-2">
        <input
          type="number"
          value={leverage}
          onChange={(e) => setLeverage(e.target.value)}
          placeholder="e.g. 20"
          className="flex-1 bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-sm text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <button
          onClick={handleUpdate}
          disabled={submitting}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Set'}
        </button>
      </div>
      <p className="text-xs text-text-tertiary font-sans">
        Current: {market.account.maxLeverage / LEVERAGE_SCALE}x
      </p>
    </div>
  );
}

function UpdateOracleConfigPanel({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const isPerkOracle = market.account.oracleSource === OracleSource.PerkOracle;
  const [maxPriceChangeBps, setMaxPriceChangeBps] = useState('');
  const [minSources, setMinSources] = useState('');
  const [maxStaleness, setMaxStaleness] = useState('');
  const [circuitBreakerBps, setCircuitBreakerBps] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  if (!isPerkOracle) {
    return (
      <div className="bg-surface px-5 py-5 space-y-3">
        <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
          Oracle Config
        </div>
        <p className="text-xs text-text-secondary font-sans">
          N/A — Market uses {oracleSourceLabel(market.account.oracleSource)}
        </p>
      </div>
    );
  }

  const handleUpdate = async () => {
    if (submittingRef.current) return;
    const params: UpdateOracleConfigParams = {
      maxPriceChangeBps: maxPriceChangeBps ? parseInt(maxPriceChangeBps, 10) : null,
      minSources: minSources ? parseInt(minSources, 10) : null,
      maxStalenessSeconds: maxStaleness ? parseInt(maxStaleness, 10) : null,
      circuitBreakerDeviationBps: circuitBreakerBps ? parseInt(circuitBreakerBps, 10) : null,
    };

    // Validate non-null fields are non-negative integers
    for (const [key, val] of Object.entries(params) as [string, number | null][]) {
      if (val !== null && (isNaN(val) || !Number.isInteger(val) || val < 0)) {
        toast.error(`${key} must be a non-negative integer`);
        return;
      }
    }

    if (!confirm('Update oracle configuration for this market?')) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const sig = await client.updateOracleConfig(market.account.tokenMint, params);
      toast.success(`Oracle config updated — ${truncatePubkey(sig)}`);
      setMaxPriceChangeBps('');
      setMinSources('');
      setMaxStaleness('');
      setCircuitBreakerBps('');
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Oracle Config
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          value={maxPriceChangeBps}
          onChange={(e) => setMaxPriceChangeBps(e.target.value)}
          placeholder="maxPriceChangeBps"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <input
          type="number"
          value={minSources}
          onChange={(e) => setMinSources(e.target.value)}
          placeholder="minSources"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <input
          type="number"
          value={maxStaleness}
          onChange={(e) => setMaxStaleness(e.target.value)}
          placeholder="maxStaleness (s)"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
        <input
          type="number"
          value={circuitBreakerBps}
          onChange={(e) => setCircuitBreakerBps(e.target.value)}
          placeholder="circuitBreakerBps"
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
        />
      </div>
      <button
        onClick={handleUpdate}
        disabled={submitting || (!maxPriceChangeBps && !minSources && !maxStaleness && !circuitBreakerBps)}
        className="w-full font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Update Oracle Config'}
      </button>
      <p className="text-xs text-text-tertiary font-sans">
        Leave fields empty to skip (null = no change).
      </p>
    </div>
  );
}

function FreezePerkOracle({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [frozen, setFrozen] = useState<boolean | null>(null);
  const [loadingState, setLoadingState] = useState(false);

  // Only relevant for PerkOracle markets
  const isPerkOracle = market.account.oracleSource === OracleSource.PerkOracle;

  useEffect(() => {
    if (!isPerkOracle) return;
    let cancelled = false;
    setLoadingState(true);
    client.fetchPerkOracleNullable(market.account.tokenMint)
      .then((oracle: PerkOracleAccount | null) => { if (!cancelled) setFrozen(oracle?.isFrozen ?? null); })
      .catch(() => { if (!cancelled) setFrozen(null); })
      .finally(() => { if (!cancelled) setLoadingState(false); });
    return () => { cancelled = true; };
  }, [client, market.account.tokenMint, isPerkOracle]);

  const handleToggle = async (freeze: boolean) => {
    if (submittingRef.current) return;
    if (!confirm(`${freeze ? 'Freeze' : 'Unfreeze'} this oracle? ${freeze ? 'Price updates will stop.' : ''}`)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const sig = await client.freezePerkOracle(market.account.tokenMint, freeze);
      toast.success(`Oracle ${freeze ? 'frozen' : 'unfrozen'} — ${truncatePubkey(sig)}`);
      setFrozen(freeze);
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Freeze PerkOracle
      </div>
      {!isPerkOracle ? (
        <p className="text-xs text-text-secondary font-sans">
          N/A — Market uses {oracleSourceLabel(market.account.oracleSource)}
        </p>
      ) : loadingState ? (
        <p className="text-xs text-text-secondary font-sans animate-pulse">Loading oracle state...</p>
      ) : (
        <>
          <p className="text-xs text-text-secondary font-sans">
            Status:{' '}
            <span className={frozen ? 'text-loss' : 'text-profit'}>
              {frozen ? 'FROZEN' : 'ACTIVE'}
            </span>
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleToggle(true)}
              disabled={submitting || frozen === true}
              className="font-mono text-xs px-4 py-2 rounded-[2px] border border-loss/30 text-loss hover:bg-loss/10 transition-colors disabled:opacity-50"
            >
              Freeze
            </button>
            <button
              onClick={() => handleToggle(false)}
              disabled={submitting || frozen === false}
              className="font-mono text-xs px-4 py-2 rounded-[2px] border border-profit/30 text-profit hover:bg-profit/10 transition-colors disabled:opacity-50"
            >
              Unfreeze
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SetFallbackOraclePanel({
  client,
  market,
  onRefresh,
}: {
  client: NonNullable<ReturnType<typeof usePerk>['client']>;
  market: MarketWithAddress;
  onRefresh: () => Promise<void>;
}) {
  const [address, setAddress] = useState('');
  const [source, setSource] = useState<OracleSource>(OracleSource.Pyth);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const currentFallback = market.account.fallbackOracleAddress.toBase58();
  const hasCurrentFallback = currentFallback !== PublicKey.default.toBase58();

  const handleSet = async () => {
    if (submittingRef.current) return;
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      toast.error('Invalid public key');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const params: SetFallbackOracleParams = {
        fallbackOracleSource: source,
        fallbackOracleAddress: pubkey,
      };
      const sig = await client.adminSetFallbackOracle(market.account.tokenMint, market.account.creator, params);
      toast.success(`Fallback oracle set — ${truncatePubkey(sig)}`);
      setAddress('');
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const handleRemove = async () => {
    if (submittingRef.current) return;
    if (!confirm('Remove fallback oracle? The market will rely solely on the primary oracle.')) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const params: SetFallbackOracleParams = {
        fallbackOracleSource: OracleSource.Pyth,
        fallbackOracleAddress: PublicKey.default,
      };
      const sig = await client.adminSetFallbackOracle(market.account.tokenMint, market.account.creator, params);
      toast.success(`Fallback oracle removed — ${truncatePubkey(sig)}`);
      await onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, 'admin'));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div className="bg-surface px-5 py-5 space-y-3">
      <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">
        Fallback Oracle
      </div>
      {hasCurrentFallback && (
        <p className="text-xs text-text-secondary font-sans">
          Current: <span className="font-mono text-white">{truncatePubkey(currentFallback)}</span>
          {' '}({oracleSourceLabel(market.account.fallbackOracleSource)})
        </p>
      )}
      <input
        type="text"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Oracle address"
        className="w-full bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white placeholder:text-text-tertiary focus:outline-none focus:border-text-secondary"
      />
      <div className="flex gap-2 items-center">
        <select
          value={source}
          onChange={(e) => setSource(Number(e.target.value) as OracleSource)}
          className="bg-bg border border-border rounded-[2px] px-3 py-2 font-mono text-xs text-white focus:outline-none focus:border-text-secondary"
        >
          <option value={OracleSource.Pyth}>Pyth</option>
          <option value={OracleSource.PerkOracle}>PerkOracle</option>
          <option value={OracleSource.DexPool}>DexPool</option>
        </select>
        <button
          onClick={handleSet}
          disabled={submitting || !address}
          className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-white hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          {submitting ? '...' : 'Set'}
        </button>
        {hasCurrentFallback && (
          <button
            onClick={handleRemove}
            disabled={submitting}
            className="font-mono text-xs px-4 py-2 rounded-[2px] border border-loss/30 text-loss hover:bg-loss/10 transition-colors disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
