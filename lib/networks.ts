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
    rpc: 'https://rpc.monad.xyz',
    explorer: 'https://monadexplorer.com',
    active: false,
    blocksPerEpoch: 50000,
  },
};
