/* External Imports */
import { getLogger } from '@eth-optimism/core-utils'
import { exit } from 'process'
import { Signer, Wallet } from 'ethers'
import {
  Provider,
  JsonRpcProvider,
  TransactionReceipt,
} from '@ethersproject/providers'
import { OptimismProvider } from '@eth-optimism/provider'
import { config } from 'dotenv'
config()

/* Internal Imports */
import {
  TransactionBatchSubmitter,
  BatchSubmitter,
  StateBatchSubmitter,
  STATE_BATCH_SUBMITTER_LOG_TAG,
  TX_BATCH_SUBMITTER_LOG_TAG,
} from '..'

/* Logger */
const log = getLogger('oe:batch-submitter:init')

interface RequiredEnvVars {
  // The HTTP provider URL for L1.
  L1_NODE_WEB3_URL: 'L1_NODE_WEB3_URL'
  // The HTTP provider URL for L2.
  L2_NODE_WEB3_URL: 'L2_NODE_WEB3_URL'
  // The minimum size in bytes of any L1 transactions generated by the batch submitter.
  MIN_TX_SIZE: 'MIN_TX_SIZE'
  // The maximum size in bytes of any L1 transactions generated by the batch submitter.
  MAX_TX_SIZE: 'MAX_TX_SIZE'
  // The maximum number of L2 transactions that can ever be in a batch.
  MAX_BATCH_SIZE: 'MAX_BATCH_SIZE'
  // The maximum amount of time (seconds) that we will wait before submitting an under-sized batch.
  MAX_BATCH_SUBMISSION_TIME: 'MAX_BATCH_SUBMISSION_TIME'
  // The delay in seconds between querying L2 for more transactions / to create a new batch.
  POLL_INTERVAL: 'POLL_INTERVAL'
  // The number of confirmations which we will wait after appending new batches.
  NUM_CONFIRMATIONS: 'NUM_CONFIRMATIONS'
  // The number of seconds to wait before resubmitting a transaction.
  RESUBMISSION_TIMEOUT: 'RESUBMISSION_TIMEOUT'
  // The number of confirmations that we should wait before submitting state roots for CTC elements.
  FINALITY_CONFIRMATIONS: 'FINALITY_CONFIRMATIONS'
  // Whether or not to run the tx batch submitter.
  RUN_TX_BATCH_SUBMITTER: 'true' | 'false' | 'RUN_TX_BATCH_SUBMITTER'
  // Whether or not to run the state batch submitter.
  RUN_STATE_BATCH_SUBMITTER: 'true' | 'false' | 'RUN_STATE_BATCH_SUBMITTER'
  // The safe minimum amount of ether the batch submitter key should
  // hold before it starts to log errors.
  SAFE_MINIMUM_ETHER_BALANCE: 'SAFE_MINIMUM_ETHER_BALANCE'
  // A boolean to clear the pending transactions in the mempool
  // on start up.
  CLEAR_PENDING_TXS: 'true' | 'false' | 'CLEAR_PENDING_TXS',
  ADDRESS_MANAGER_ADDRESS:'ADDRESS_MANAGER_ADDRESS',
}
const requiredEnvVars: RequiredEnvVars = {
  L1_NODE_WEB3_URL: 'L1_NODE_WEB3_URL',
  L2_NODE_WEB3_URL: 'L2_NODE_WEB3_URL',
  MIN_TX_SIZE: 'MIN_TX_SIZE',
  MAX_TX_SIZE: 'MAX_TX_SIZE',
  MAX_BATCH_SIZE: 'MAX_BATCH_SIZE',
  MAX_BATCH_SUBMISSION_TIME: 'MAX_BATCH_SUBMISSION_TIME',
  POLL_INTERVAL: 'POLL_INTERVAL',
  NUM_CONFIRMATIONS: 'NUM_CONFIRMATIONS',
  RESUBMISSION_TIMEOUT: 'RESUBMISSION_TIMEOUT',
  FINALITY_CONFIRMATIONS: 'FINALITY_CONFIRMATIONS',
  RUN_TX_BATCH_SUBMITTER: 'RUN_TX_BATCH_SUBMITTER',
  RUN_STATE_BATCH_SUBMITTER: 'RUN_STATE_BATCH_SUBMITTER',
  SAFE_MINIMUM_ETHER_BALANCE: 'SAFE_MINIMUM_ETHER_BALANCE',
  CLEAR_PENDING_TXS: 'CLEAR_PENDING_TXS',
  ADDRESS_MANAGER_ADDRESS:'ADDRESS_MANAGER_ADDRESS',
}

/* Optional Env Vars
 * FRAUD_SUBMISSION_ADDRESS
 * DISABLE_QUEUE_BATCH_APPEND
 * SEQUENCER_PRIVATE_KEY
 * MNEMONIC
 */
const env = process.env
const FRAUD_SUBMISSION_ADDRESS = env.FRAUD_SUBMISSION_ADDRESS || 'no fraud'
const DISABLE_QUEUE_BATCH_APPEND = !!env.DISABLE_QUEUE_BATCH_APPEND
// The private key that will be used to submit tx and state batches.
const SEQUENCER_PRIVATE_KEY = env.SEQUENCER_PRIVATE_KEY
const MNEMONIC = env.MNEMONIC
const HD_PATH = env.HD_PATH

export const run = async () => {
  log.info('Starting batch submitter...')

  for (const [i, val] of Object.entries(requiredEnvVars)) {
    if (!process.env[val]) {
      log.error(`Missing enviornment variable: ${val}`)
      exit(1)
    }
    requiredEnvVars[val] = process.env[val]
  }

  const clearPendingTxs = requiredEnvVars.CLEAR_PENDING_TXS === 'true'

  const l1Provider: Provider = new JsonRpcProvider(
    requiredEnvVars.L1_NODE_WEB3_URL
  )
  const l2Provider: OptimismProvider = new OptimismProvider(
    requiredEnvVars.L2_NODE_WEB3_URL
  )

  let sequencerSigner: Signer
  if (SEQUENCER_PRIVATE_KEY) {
    sequencerSigner = new Wallet(
      SEQUENCER_PRIVATE_KEY,
      l1Provider
    )
  } else if (MNEMONIC) {
    sequencerSigner = Wallet.fromMnemonic(MNEMONIC, HD_PATH).connect(l1Provider)
  } else {
    throw new Error('Must pass one of SEQUENCER_PRIVATE_KEY or MNEMONIC')
  }

  const address = await sequencerSigner.getAddress()
  log.info(`Using sequencer address: ${address}`)
  const chainId=await l2Provider.send('eth_chainId', [])
  const txBatchSubmitter = new TransactionBatchSubmitter(
    sequencerSigner,
    l2Provider,
    parseInt(requiredEnvVars.MIN_TX_SIZE, 10),
    parseInt(requiredEnvVars.MAX_TX_SIZE, 10),
    parseInt(requiredEnvVars.MAX_BATCH_SIZE, 10),
    parseInt(requiredEnvVars.MAX_BATCH_SUBMISSION_TIME, 10) * 1_000,
    parseInt(requiredEnvVars.NUM_CONFIRMATIONS, 10),
    parseInt(requiredEnvVars.RESUBMISSION_TIMEOUT, 10) * 1_000,
    true,
    requiredEnvVars.ADDRESS_MANAGER_ADDRESS,
    parseFloat(requiredEnvVars.SAFE_MINIMUM_ETHER_BALANCE),
    getLogger(TX_BATCH_SUBMITTER_LOG_TAG),
    DISABLE_QUEUE_BATCH_APPEND
  )
  txBatchSubmitter.setChainId(chainId)

  const stateBatchSubmitter = new StateBatchSubmitter(
    sequencerSigner,
    l2Provider,
    parseInt(requiredEnvVars.MIN_TX_SIZE, 10),
    parseInt(requiredEnvVars.MAX_TX_SIZE, 10),
    parseInt(requiredEnvVars.MAX_BATCH_SIZE, 10),
    parseInt(requiredEnvVars.MAX_BATCH_SUBMISSION_TIME, 10) * 1_000,
    parseInt(requiredEnvVars.NUM_CONFIRMATIONS, 10),
    parseInt(requiredEnvVars.RESUBMISSION_TIMEOUT, 10) * 1_000,
    parseInt(requiredEnvVars.FINALITY_CONFIRMATIONS, 10),
    true,
    requiredEnvVars.ADDRESS_MANAGER_ADDRESS,
    parseFloat(requiredEnvVars.SAFE_MINIMUM_ETHER_BALANCE),
    getLogger(STATE_BATCH_SUBMITTER_LOG_TAG),
    FRAUD_SUBMISSION_ADDRESS
  )
  stateBatchSubmitter.setChainId(chainId)

  // Loops infinitely!
  const loop = async (
    func: () => Promise<TransactionReceipt>
  ): Promise<void> => {
    // Clear all pending transactions
    if (clearPendingTxs) {
      try {
        const pendingTxs = await sequencerSigner.getTransactionCount('pending')
        const latestTxs = await sequencerSigner.getTransactionCount('latest')
        if (pendingTxs > latestTxs) {
          log.info('Detected pending transactions. Clearing all transactions!')
          for (let i = latestTxs; i < pendingTxs; i++) {
            const response = await sequencerSigner.sendTransaction({
              to: await sequencerSigner.getAddress(),
              value: 0,
              nonce: i,
            })
            log.info(`Submitting transaction with nonce: ${i}; hash: ${response.hash}`)
            await BatchSubmitter.getReceiptWithResubmission(
              response,
              [],
              sequencerSigner,
              parseInt(requiredEnvVars.NUM_CONFIRMATIONS, 10),
              60 * 1_000,  // Attempt resubmission every 60 seconds
              log,
            )
          }
        }
      } catch (err) {
        log.error('Cannot clear transactions', err)
        process.exit(1)
      }
    }

    while (true) {
      try {
        await func()
      } catch (err) {
        log.error('Error submitting batch', err)
        log.info('Retrying...')
      }
      // Sleep
      await new Promise((r) =>
        setTimeout(r, parseInt(requiredEnvVars.POLL_INTERVAL, 10))
      )
    }
  }

  // Run batch submitters in two seperate infinite loops!
  if (requiredEnvVars.RUN_TX_BATCH_SUBMITTER === 'true') {
    loop(() => txBatchSubmitter.submitNextBatch())
  }
  if (requiredEnvVars.RUN_STATE_BATCH_SUBMITTER === 'true') {
    loop(() => stateBatchSubmitter.submitNextBatch())
  }
}
