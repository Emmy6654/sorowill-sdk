import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export interface TransactionMatchOptions {
  intendedTransactionXdr: string;
  preparedTransactionXdr: string;
  networkPassphrase: string;
  context: string;
}

function readOperationsFromEnvelope(
  transactionXdr: string,
  networkPassphrase: string,
): xdr.Operation[] {
  const transaction = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  const envelope = transaction.toEnvelope() as unknown as {
    v0?: () => { tx: () => { operations: () => xdr.Operation[] } };
    v1?: () => { tx: () => { operations: () => xdr.Operation[] } };
    feeBump?: () => {
      tx: () => {
        innerTx: () => {
          v1: () => { tx: () => { operations: () => xdr.Operation[] } };
        };
      };
    };
  };

  if (typeof envelope.v1 === 'function') {
    try {
      return envelope.v1().tx().operations();
    } catch {
      // fall through and try the remaining envelope variants
    }
  }

  if (typeof envelope.v0 === 'function') {
    try {
      return envelope.v0().tx().operations();
    } catch {
      // fall through and try the remaining envelope variants
    }
  }

  if (typeof envelope.feeBump === 'function') {
    try {
      return envelope.feeBump().tx().innerTx().v1().tx().operations();
    } catch {
      // fall through to the final error below
    }
  }

  throw new Error('Unable to decode transaction operations from XDR envelope');
}

export function assertPreparedTransactionMatchesIntendedOperation(
  options: TransactionMatchOptions,
): void {
  const intendedOperations = readOperationsFromEnvelope(
    options.intendedTransactionXdr,
    options.networkPassphrase,
  );
  const preparedOperations = readOperationsFromEnvelope(
    options.preparedTransactionXdr,
    options.networkPassphrase,
  );

  if (preparedOperations.length !== intendedOperations.length) {
    throw new Error(
      `Prepared transaction for ${options.context} contained ${preparedOperations.length} operation(s), expected ${intendedOperations.length}`,
    );
  }

  for (let index = 0; index < intendedOperations.length; index += 1) {
    const intended = intendedOperations[index];
    const prepared = preparedOperations[index];
    if (!intended || !prepared) {
      throw new Error(`Prepared transaction for ${options.context} was missing operation ${index}`);
    }

    if (prepared.toXDR('base64') !== intended.toXDR('base64')) {
      throw new Error(
        `Prepared transaction for ${options.context} did not match the intended operation at index ${index}`,
      );
    }
  }
}
