import type { ContractRunner, TypedDataDomain } from "ethers";

export const RESOLUTION_EIP712_TYPES = {
  Resolution: [
    { name: "marketId", type: "uint256" },
    { name: "outcome", type: "uint8" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export async function predictionMarketResolutionDomain(pm: {
  getAddress(): Promise<string>;
  runner?: ContractRunner | null;
}) {
  const provider = pm.runner!.provider!;
  const net = await provider.getNetwork();
  const verifyingContract = await pm.getAddress();
  const domain: TypedDataDomain = {
    name: "PredictionMarket",
    version: "1",
    chainId: net.chainId,
    verifyingContract,
  };
  return domain;
}

/** Outcome matches `Outcome` enum on-chain (Yes = 1, No = 2). */
export async function signResolution(
  signer: {
    signTypedData: (
      domain: TypedDataDomain,
      types: typeof RESOLUTION_EIP712_TYPES,
      value: { marketId: bigint; outcome: bigint; deadline: bigint; nonce: bigint },
    ) => Promise<string>;
  },
  pm: { getAddress(): Promise<string>; runner?: ContractRunner | null },
  value: { marketId: bigint; outcome: bigint; deadline: bigint; nonce: bigint },
) {
  const domain = await predictionMarketResolutionDomain(pm);
  return signer.signTypedData(domain, RESOLUTION_EIP712_TYPES, value);
}

export async function collectResolutionSignatures(
  signers: Array<{
    signTypedData: (
      domain: TypedDataDomain,
      types: typeof RESOLUTION_EIP712_TYPES,
      value: { marketId: bigint; outcome: bigint; deadline: bigint; nonce: bigint },
    ) => Promise<string>;
  }>,
  pm: { getAddress(): Promise<string>; runner?: ContractRunner | null },
  value: { marketId: bigint; outcome: bigint; deadline: bigint; nonce: bigint },
) {
  const sigs: string[] = [];
  for (const s of signers) {
    sigs.push(await signResolution(s, pm, value));
  }
  return sigs;
}
