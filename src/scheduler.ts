import { WsProvider, ApiPromise } from '@polkadot/api'
import { Signer, SubmittableExtrinsic } from '@polkadot/api/types'
import { Balance } from '@polkadot/types/interfaces'
import { ISubmittableResult } from '@polkadot/types/types'
import { HexString } from '@polkadot/util/types'
import * as _ from 'lodash'

import {
  LOWEST_TRANSFERRABLE_AMOUNT,
  MIN_IN_HOUR,
  MS_IN_SEC,
  OakChainSchedulingLimit,
  OakChainWebsockets,
  RECURRING_TASK_LIMIT,
  SEC_IN_MIN,
} from './constants'

export class Scheduler {
  wsProvider: WsProvider
  api: ApiPromise
  chain: OakChains
  schedulingTimeLimit: number

  constructor(chain: OakChains) {
    this.chain = chain
    this.wsProvider = new WsProvider(OakChainWebsockets[chain])
    this.schedulingTimeLimit = OakChainSchedulingLimit[chain]
  }

  private async getAPIClient(): Promise<ApiPromise> {
    if (_.isNil(this.api)) {
      this.api = await ApiPromise.create({
        provider: this.wsProvider,
        rpc: {
          automationTime: {
            generateTaskId: {
              description: 'Getting task ID given account ID and provided ID',
              params: [
                {
                  name: 'accountId',
                  type: 'AccountId',
                },
                {
                  name: 'providedId',
                  type: 'Text',
                },
              ],
              type: 'Hash',
            },
          },
        },
      })
    }
    return this.api
  }

  private convertToSeconds(startTimestamps: number[]): number[] {
    return _.map(startTimestamps, startTimestamp => {
      const isMillisecond = startTimestamp > 100000000000
      if (isMillisecond) return startTimestamp / MS_IN_SEC
      return startTimestamp
    })
  }

  async defaultErrorHandler(result: ISubmittableResult): Promise<void> {
    console.log(`Tx status: ${result.status.type}`)
    if (result.status.isFinalized) {
      if (!_.isNil(result.dispatchError)) {
        if (result.dispatchError.isModule) {
          const api = await this.getAPIClient()
          const metaError = api.registry.findMetaError(result.dispatchError.asModule)
          const { docs, name, section } = metaError
          const dispatchErrorMessage = JSON.stringify({ docs, name, section })
          const errMsg = `Transaction finalized with error by blockchain ${dispatchErrorMessage}`
          console.log(errMsg)
        } else {
          const errMsg = `Transaction finalized with error by blockchain ${result.dispatchError.toString()}`
          console.log(errMsg)
        }
      }
    }
  }

  /**
   * GetInclusionFees: gets the fees for inclusion ONLY. This does not include execution fees.
   * @param extrinsic
   * @param address
   * @returns
   */
  async getInclusionFees(
    extrinsic: SubmittableExtrinsic<'promise', ISubmittableResult>,
    address: string
  ): Promise<Balance> {
    const paymentInfo = await extrinsic.paymentInfo(address)
    return paymentInfo.partialFee
  }

  /**
   * GetTaskID: gets the next available Task ID
   * @param address
   * @param providedID
   * @returns next available task ID
   */
  async getTaskID(address: string, providedID: string): Promise<string> {
    const polkadotApi = await this.getAPIClient()
    // TODO: hack until we can merge correct types into polkadotAPI
    const taskIdCodec = await (polkadotApi.rpc as any).automationTime.generateTaskId(address, providedID)
    return taskIdCodec.toString()
  }

  /**
   * validateTimestamps: validates timestamps are:
   * 1. on the hour
   * 2. in a future time slot
   * 3. limited to 24 time slots
   */
  validateTimestamps(timestamps: number[]): void {
    if (timestamps.length > RECURRING_TASK_LIMIT)
      throw new Error(`Recurring Task length cannot exceed ${RECURRING_TASK_LIMIT}`)
    const currentTime = Date.now()
    const nextAvailableHour =
      (currentTime - (currentTime % (SEC_IN_MIN * MIN_IN_HOUR * MS_IN_SEC)) + SEC_IN_MIN * MIN_IN_HOUR * MS_IN_SEC) / 1000
    _.forEach(timestamps, (timestamp) => {
      if (timestamp < nextAvailableHour) throw new Error('Scheduled timestamp in the past')
      if (timestamp % (SEC_IN_MIN * MIN_IN_HOUR) !== 0) throw new Error('Timestamp is not an hour timestamp')
      if (timestamp > currentTime + this.schedulingTimeLimit) throw new Error('Timestamp too far in future')
    })
  }

  /**
   * validateTimestamps: validates timestamps are:
   * 1. on the hour
   * 2. in a future time slot
   * 3. limited to 24 time slots
   */
  validateTransferParams(amount: number, sendingAddress: string, receivingAddress: string): void {
    if (amount < LOWEST_TRANSFERRABLE_AMOUNT) throw new Error(`Amount too low`)
    if (sendingAddress === receivingAddress) throw new Error(`Cannot send to self`)
  }

  /**
   * SendExtrinsic: sends built and signed extrinsic to the chain
   * @param extrinsic
   * @param handleDispatch
   * @returns unsubscribe function
   */
  async sendExtrinsic(
    extrinsicHex: HexString,
    /* eslint-disable  @typescript-eslint/no-explicit-any */
    handleDispatch: (result: ISubmittableResult) => any
  ): Promise<string> {
    const polkadotApi = await this.getAPIClient()
    const txObject = polkadotApi.tx(extrinsicHex)
    const unsub = await txObject.send(async (result) => {
      if (_.isNil(handleDispatch)) {
        console.log(`Using default error handler`)
        await this.defaultErrorHandler(result)
      } else {
        console.log(`Using custom error handler`)
        await handleDispatch(result)
      }
    })
    unsub()
    return txObject.hash.toString()
  }

  /**
   * BuildScheduleNotifyExtrinsic: builds and signs a schedule notify task extrinsic via polkadot.js extension
   * Function gets the next available nonce for user.
   * Therefore, will need to wait for transaction finalization before sending another.
   * Timestamps must be in seconds
   * @param address
   * @param providedID
   * @param timestamp
   * @param receivingAddress
   * @param amount
   * @returns extrinsic hex, format: `0x${string}`
   */
  async buildScheduleNotifyExtrinsic(
    address: string,
    providedID: number,
    timestamps: number[],
    message: string,
    signer: Signer
  ): Promise<HexString> {
    this.validateTimestamps(timestamps)
    const secondTimestamps = this.convertToSeconds(timestamps)
    const polkadotApi = await this.getAPIClient()
    const extrinsic = polkadotApi.tx['automationTime']['scheduleNotifyTask'](providedID, secondTimestamps, message)
    const signedExtrinsic = await extrinsic.signAsync(address, {
      signer,
      nonce: -1,
    })
    return signedExtrinsic.toHex()
  }

  /**
   * BuildScheduleNativeTransferExtrinsic: builds and signs a transfer notify task extrinsic via polkadot.js extension.
   * Function gets the next available nonce for user.
   * Therefore, will need to wait for transaction finalization before sending another.
   * Timestamps are an 24-item bounded array of unix timestamps
   * @param address
   * @param providedID
   * @param timestamp
   * @param receivingAddress
   * @param amount
   * @returns extrinsic hex, format: `0x${string}`
   */
  async buildScheduleNativeTransferExtrinsic(
    address: string,
    providedID: string,
    timestamps: number[],
    receivingAddress: string,
    amount: number,
    signer: Signer
  ): Promise<HexString> {
    this.validateTimestamps(timestamps)
    this.validateTransferParams(amount, address, receivingAddress)
    const secondTimestamps = this.convertToSeconds(timestamps)
    const polkadotApi = await this.getAPIClient()
    const extrinsic = polkadotApi.tx['automationTime']['scheduleNativeTransferTask'](
      providedID,
      secondTimestamps,
      receivingAddress,
      amount
    )
    const signedExtrinsic = await extrinsic.signAsync(address, {
      signer,
      nonce: -1,
    })
    return signedExtrinsic.toHex()
  }

  /**
   * BuildCancelTaskExtrinsic: builds extrinsic for cancelling a task
   * @param address
   * @param providedID
   * @returns
   */
  async buildCancelTaskExtrinsic(address: string, providedID: number, signer: Signer): Promise<HexString> {
    const polkadotApi = await this.getAPIClient()
    const extrinsic = polkadotApi.tx['automationTime']['cancelTask'](providedID)
    const signedExtrinsic = await extrinsic.signAsync(address, {
      signer,
      nonce: -1,
    })
    return signedExtrinsic.toHex()
  }
}
