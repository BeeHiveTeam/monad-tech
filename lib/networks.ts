export type NetworkId = 'testnet' | 'mainnet';

export interface Network {
  id: NetworkId;
  name: string;
  chainId: number;
  rpc: string;
  explorer: string;
  active: boolean;
  blocksPerEpoch: number;
}

export const NETWORKS: Record<NetworkId, Network> = {
  testnet: {
    id: 'testnet',
    name: 'Monad Testnet',
    chainId: 10143,
    rpc: 'https://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadexplorer.com',
    active: true,
    blocksPerEpoch: 50000,
  },
  mainnet: {
    id: 'mainnet',
    name: 'Monad Mainnet',
    chainId: 143,
    // Foundation-operated public RPC. Override via MONAD_MAINNET_RPC.
    // Tatum tested earlier at 100ms but enforces a 5 req/min limit on
    // its free tier — too aggressive for our load. rpc.monad.xyz
    // (QuickNode-backed) accepts our request rate cleanly.
    // When we eventually run our own mainnet validator, swap this to the
    // local URL like testnet does via process.env.MONAD_RPC_URL.
    rpc: process.env.MONAD_MAINNET_RPC || 'https://rpc.monad.xyz',
    explorer: 'https://monadscan.com',
    active: true,
    blocksPerEpoch: 50000,
  },
};
