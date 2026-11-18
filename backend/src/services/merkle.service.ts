import crypto from 'crypto';

export interface MerkleTreeResult {
  merkleRoot: string;
  leaves: string[];
  leafCount: number;
}

export interface MerkleLeaf {
  id?: string;
  sourceType: string;
  payload: any;
  payloadHash?: string;
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const strip0x = (h: string) => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
const toBuf = (h: string) => Buffer.from(strip0x(h).padStart(64, '0'), 'hex');
const toHex = (b: Buffer) => '0x' + b.toString('hex');
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest();

/**
 * SHA-256 Merkle tree with domain separation, matching CarbonRegistry.verifyEvidenceInclusion on-chain:
 *   leaf = sha256(0x00 || payloadHash)
 *   node = sha256(0x01 || min(left,right) || max(left,right))
 * Leaves are sorted canonically so the root does not depend on DB row order, and an odd node is
 * promoted unchanged (never duplicated), which avoids the classic duplicate-leaf second-preimage issue.
 */
export class MerkleService {
  private static hashLeaf(payloadHash: string): Buffer {
    return sha256(Buffer.concat([LEAF_PREFIX, toBuf(payloadHash)]));
  }

  private static hashNode(a: Buffer, b: Buffer): Buffer {
    const [l, r] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
    return sha256(Buffer.concat([NODE_PREFIX, l, r]));
  }

  /** Canonical ordering used for both the root and proofs. */
  public static canonicalize(payloadHashes: string[]): string[] {
    return payloadHashes.map((h) => toHex(toBuf(h))).sort();
  }

  /** Hashes an evidence item into a 32-byte payload hash (the pre-image of a Merkle leaf). */
  public static hashItem(item: MerkleLeaf): string {
    if (item.payloadHash) return toHex(toBuf(item.payloadHash));
    const serialized = typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload);
    return toHex(sha256(Buffer.from(serialized)));
  }

  public static computeMerkleTree(payloadHashes: string[]): MerkleTreeResult {
    if (!payloadHashes || payloadHashes.length === 0) {
      throw new Error('Cannot compute Merkle tree with 0 leaves');
    }

    const leaves = this.canonicalize(payloadHashes);
    let level: Buffer[] = leaves.map((h) => this.hashLeaf(h));

    while (level.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(i + 1 < level.length ? this.hashNode(level[i], level[i + 1]) : level[i]);
      }
      level = next;
    }

    return { merkleRoot: toHex(level[0]), leaves, leafCount: leaves.length };
  }

  public static computeMerkleRoot(payloadHashes: string[]): string {
    if (!payloadHashes || payloadHashes.length === 0) return '0x' + '0'.repeat(64);
    return this.computeMerkleTree(payloadHashes).merkleRoot;
  }

  /** Inclusion proof (sibling hashes, bottom-up) for the leaf with the given payload hash. */
  public static generateProofForHash(payloadHashes: string[], payloadHash: string): string[] {
    const leaves = this.canonicalize(payloadHashes);
    const index = leaves.indexOf(toHex(toBuf(payloadHash)));
    if (index === -1) throw new Error('Payload hash is not part of this bundle');
    return this.generateProof(leaves, index);
  }

  /** Inclusion proof by index into the canonical (sorted) leaf list. */
  public static generateProof(payloadHashes: string[], leafIndex: number): string[] {
    const leaves = this.canonicalize(payloadHashes);
    if (leafIndex < 0 || leafIndex >= leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of bounds`);
    }

    let level: Buffer[] = leaves.map((h) => this.hashLeaf(h));
    const proof: string[] = [];
    let idx = leafIndex;

    while (level.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          if (idx === i) proof.push(toHex(level[i + 1]));
          else if (idx === i + 1) proof.push(toHex(level[i]));
          next.push(this.hashNode(level[i], level[i + 1]));
        } else {
          next.push(level[i]); // promoted, no sibling at this level
        }
      }
      idx = Math.floor(idx / 2);
      level = next;
    }

    return proof;
  }

  /** Verify a proof against a root (same algorithm as the on-chain verifier). */
  public static verifyProof(payloadHash: string, proof: string[], merkleRoot: string): boolean {
    try {
      let node = this.hashLeaf(payloadHash);
      for (const sibling of proof) node = this.hashNode(node, toBuf(sibling));
      return toHex(node) === toHex(toBuf(merkleRoot));
    } catch {
      return false;
    }
  }
}
