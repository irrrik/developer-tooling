import { CELO_DERIVATION_PATH_BASE } from '@celo/base/lib/account'
import { zeroRange } from '@celo/base/lib/collections'
import { Address, CeloTx, EncodedTransaction, ReadOnlyWallet } from '@celo/connect'
import { RemoteWallet } from '@celo/wallet-remote'
import { TransportError, TransportStatusError } from '@ledgerhq/errors'
import Ledger from '@ledgerhq/hw-app-eth'
import debugFactory from 'debug'
import { LedgerSigner } from './ledger-signer'
import { transportErrorFriendlyMessage } from './ledger-utils'
import { ILedger } from './types'

export const CELO_BASE_DERIVATION_PATH = `${CELO_DERIVATION_PATH_BASE.slice(2)}/0`
const ADDRESS_QTY = 5

// Validates an address using the Ledger
export enum AddressValidation {
  // Validates every address required only when the ledger is initialized
  initializationOnly,
  // Validates the address every time a transaction is made
  everyTransaction,
  // Validates the address the first time a transaction is made for that specific address
  firstTransactionPerAddress,
  // Never validates the addresses
  never,
}

export async function newLedgerWalletWithSetup(
  transport: any,
  derivationPathIndexes?: number[],
  baseDerivationPath?: string,
  ledgerAddressValidation?: AddressValidation
): Promise<LedgerWallet> {
  const wallet = new LedgerWallet(
    derivationPathIndexes,
    baseDerivationPath,
    transport,
    ledgerAddressValidation
  )
  await wallet.init()
  return wallet
}

const debug = debugFactory('kit:wallet:ledger')

export class LedgerWallet extends RemoteWallet<LedgerSigner> implements ReadOnlyWallet {
  private ledger: ILedger | undefined

  /**
   * @param derivationPathIndexes number array of "address_index" for the base derivation path.
   * Default: Array[0..9].
   * Example: [3, 99, 53] will retrieve the derivation paths of
   * [`${baseDerivationPath}/3`, `${baseDerivationPath}/99`, `${baseDerivationPath}/53`]
   * @param baseDerivationPath base derivation path. Default: "44'/52752'/0'/0"
   * @param transport Transport to connect the ledger device
   */
  constructor(
    readonly derivationPathIndexes: number[] = zeroRange(ADDRESS_QTY),
    readonly baseDerivationPath: string = CELO_BASE_DERIVATION_PATH,
    readonly transport: any = {},
    readonly ledgerAddressValidation: AddressValidation = AddressValidation.firstTransactionPerAddress
  ) {
    super()
    const invalidDPs = derivationPathIndexes.some(
      (value) => !(Number.isInteger(value) && value >= 0)
    )
    if (invalidDPs) {
      throw new Error('ledger-wallet: Invalid address index')
    }
  }

  signTransaction(txParams: CeloTx): Promise<EncodedTransaction> {
    // CeloLedger does not support maxFeePerGas and maxPriorityFeePerGas yet
    txParams.gasPrice = txParams.gasPrice ?? txParams.maxFeePerGas
    if (txParams.maxFeePerGas || txParams.maxPriorityFeePerGas) {
      console.info(
        'maxFeePerGas and maxPriorityFeePerGas are not supported on Ledger yet. Automatically using gasPrice instead.'
      )
      delete txParams.maxFeePerGas
      delete txParams.maxPriorityFeePerGas
    }
    return super.signTransaction(txParams)
  }

  protected async loadAccountSigners(): Promise<Map<Address, LedgerSigner>> {
    if (!this.ledger) {
      this.ledger = this.generateNewLedger(this.transport) as ILedger
    }
    debug('Fetching addresses from the ledger')
    let addressToSigner = new Map<Address, LedgerSigner>()
    try {
      addressToSigner = await this.retrieveAccounts()
    } catch (error) {
      if (error instanceof TransportStatusError || error instanceof TransportError) {
        transportErrorFriendlyMessage(error)
      }
      throw error
    }
    return addressToSigner
  }

  // Extracted for testing purpose
  private generateNewLedger(transport: any) {
    return new Ledger(transport)
  }

  private async retrieveAccounts(): Promise<Map<Address, LedgerSigner>> {
    const addressToSigner = new Map<Address, LedgerSigner>()
    const appConfiguration = await this.retrieveAppConfiguration()
    const validationRequired = this.ledgerAddressValidation === AddressValidation.initializationOnly

    // Each address must be retrieved synchronously, (ledger lock)
    for (const value of this.derivationPathIndexes) {
      const derivationPath = `${this.baseDerivationPath}/${value}`
      const addressInfo = await this.ledger!.getAddress(derivationPath, validationRequired)
      addressToSigner.set(
        addressInfo.address!,
        new LedgerSigner(
          this.ledger!,
          derivationPath,
          this.ledgerAddressValidation,
          appConfiguration
        )
      )
    }
    return addressToSigner
  }

  private async retrieveAppConfiguration(): Promise<{
    arbitraryDataEnabled: number
    version: string
  }> {
    const appConfiguration = await this.ledger!.getAppConfiguration()
    if (!appConfiguration.arbitraryDataEnabled) {
      console.warn(
        'Beware, your ledger does not allow the use of contract data. Some features may not work correctly, including token transfers. You can enable it from the ledger app settings.'
      )
    }
    return appConfiguration
  }
}
