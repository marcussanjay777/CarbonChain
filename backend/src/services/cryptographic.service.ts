import crypto from 'crypto';
import { ethers } from 'ethers';

export class CryptographicService {
  /**
   * Generates a W3C-compliant DID for a project owner
   */
  public static generateDID(ownerAddress: string): string {
    const cleanAddress = ownerAddress.toLowerCase();
    return `did:carbonyx:${cleanAddress}`;
  }

  /**
   * Generates a W3C-compliant decentralized identifier (DID) for a carbon project
   * Format: did:carbonyx:0x<hash>
   */
  public static generateProjectDID(projectId: string, ownerAddress: string): string {
    const raw = `${projectId.toLowerCase()}:${ownerAddress.toLowerCase()}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 40);
    return `did:carbonyx:0x${hash}`;
  }

  /**
   * Canonical JSON: object keys sorted recursively, so semantically equal payloads hash identically and
   * a change to ANY nested field changes the hash.
   */
  public static canonicalize(value: any): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((v) => this.canonicalize(v)).join(',')}]`;
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${this.canonicalize(value[k])}`).join(',')}}`;
  }

  /**
   * Generates a deterministic SHA-256 hash of a JSON payload
   */
  public static hashPayload(payload: any): string {
    const canonicalString = typeof payload === 'string' ? payload : this.canonicalize(payload);
    const hash = crypto.createHash('sha256').update(canonicalString).digest('hex');
    return `0x${hash}`;
  }

  /**
   * Generates a bytes32 identifier from a string
   */
  public static toBytes32(text: string): string {
    if (text.startsWith('0x') && text.length === 66) {
      return text;
    }
    return ethers.keccak256(ethers.toUtf8Bytes(text));
  }

  /**
   * Verifies an Ethereum signed message (EIP-191)
   */
  public static verifySignature(message: string, signature: string, expectedSigner: string): boolean {
    try {
      const recovered = ethers.verifyMessage(message, signature);
      return recovered.toLowerCase() === expectedSigner.toLowerCase();
    } catch {
      return false;
    }
  }
}
