import { jestRocksDB } from "../db/jestUtils.js";
import Engine from "../engine/index.js";
import { ValidateOrRevokeMessagesJobScheduler } from "./validateOrRevokeMessagesJob.js";
import { FarcasterNetwork, Factories, Message, toFarcasterTime, OnChainEvent } from "@farcaster/hub-nodejs";
import {
  HubState,
  IdRegisterOnChainEvent,
  UserDataAddMessage,
  UserDataType,
  UserNameType,
  UsernameProofMessage,
  bytesToHexString,
  bytesToUtf8String,
} from "@farcaster/core";
import { jest } from "@jest/globals";
import { publicClient } from "../../test/utils.js";
import { getHubState, putHubState } from "../../storage/db/hubState.js";

const db = jestRocksDB("jobs.ValidateOrRevokeMessagesJob.test");

const network = FarcasterNetwork.TESTNET;
const fid = Factories.Fid.build();
const signer = Factories.Ed25519Signer.build();
const custodySigner = Factories.Eip712Signer.build();

let custodyEvent: IdRegisterOnChainEvent;
let signerEvent: OnChainEvent;
let storageEvent: OnChainEvent;
let castAdd: Message;

let addFname: UserDataAddMessage;
let ensNameProof: UsernameProofMessage;

beforeAll(async () => {
  const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
  const custodySignerKey = (await custodySigner.getSignerKey())._unsafeUnwrap();
  custodyEvent = Factories.IdRegistryOnChainEvent.build({ fid }, { transient: { to: custodySignerKey } });
  signerEvent = Factories.SignerOnChainEvent.build({ fid }, { transient: { signer: signerKey } });
  storageEvent = Factories.StorageRentOnChainEvent.build({ fid });
  castAdd = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });

  const custodySignerAddress = bytesToHexString(custodySignerKey)._unsafeUnwrap();

  jest.spyOn(publicClient, "getEnsAddress").mockImplementation(() => {
    return Promise.resolve(custodySignerAddress);
  });
  ensNameProof = await Factories.UsernameProofMessage.create(
    {
      data: {
        fid,
        usernameProofBody: Factories.UserNameProof.build({
          fid,
          owner: custodySignerKey,
          name: Factories.EnsName.build(),
          type: UserNameType.USERNAME_TYPE_ENS_L1,
        }),
      },
    },
    { transient: { signer } },
  );
});

describe("ValidateOrRevokeMessagesJob", () => {
  let engine: Engine;
  let job: ValidateOrRevokeMessagesJobScheduler;

  beforeEach(async () => {
    engine = new Engine(db, network, undefined, publicClient);
    job = new ValidateOrRevokeMessagesJobScheduler(db, engine);

    await engine.start();
  });

  afterAll(async () => {
    await engine.stop();
  });

  test("doJobForFid checks message when no fid or lastJobTimestamp", async () => {
    // There is nothing in the DB, so if we add a message, it should get checked.
    await engine.mergeOnChainEvent(custodyEvent);
    await engine.mergeOnChainEvent(signerEvent);
    await engine.mergeOnChainEvent(storageEvent);

    await engine.mergeMessage(castAdd);

    const result = await job.doJobForFid(0, fid);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(1);
  });

  test("doJobForFid doesn't check message if lastJobTimestamp > signer", async () => {
    // There is nothing in the DB, so if we add a message, it should get checked.
    await engine.mergeOnChainEvent(custodyEvent);
    await engine.mergeOnChainEvent(signerEvent);
    await engine.mergeOnChainEvent(storageEvent);

    await engine.mergeMessage(castAdd);

    const blockTimeToFCTime = toFarcasterTime(1000 * signerEvent.blockTimestamp)._unsafeUnwrap();
    const result = await job.doJobForFid(blockTimeToFCTime + 1, fid);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(0);
  });

  test("doJobs checks if there is empty hub state", async () => {
    await engine.mergeOnChainEvent(custodyEvent);
    await engine.mergeOnChainEvent(signerEvent);
    await engine.mergeOnChainEvent(storageEvent);

    await engine.mergeMessage(castAdd);

    await putHubState(db, HubState.create({}));

    const result = await job.doJobs();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(1);
  });

  test("Continues job from last fid and checks username message", async () => {
    await engine.mergeOnChainEvent(custodyEvent);
    await engine.mergeOnChainEvent(signerEvent);
    await engine.mergeOnChainEvent(storageEvent);

    await engine.mergeMessage(castAdd);

    // If the lastFid is past, it should skip the FID and check nothing.
    await putHubState(db, HubState.create({ validateOrRevokeState: { lastFid: fid + 1, lastJobTimestamp: 0 } }));

    const result = await job.doJobs();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(0);

    // If the lastFid is before, it should check the FID.
    await putHubState(db, HubState.create({ validateOrRevokeState: { lastFid: fid - 1, lastJobTimestamp: 0 } }));

    const result1 = await job.doJobs();
    expect(result1.isOk()).toBe(true);
    expect(result1._unsafeUnwrap()).toBe(1);

    // Get the hub state to make sure it was written correctly
    const hubState = await getHubState(db);
    expect(hubState.validateOrRevokeState?.lastFid).toBe(0);
    expect(hubState.validateOrRevokeState?.lastJobTimestamp).toBeGreaterThan(0);

    // Running it again checks no messages
    const result2 = await job.doJobs();
    expect(result2.isOk()).toBe(true);
    expect(result2._unsafeUnwrap()).toBe(0);

    // Merge the ENS name proof
    const result3 = await engine.mergeMessage(ensNameProof);
    expect(result3.isOk()).toBe(true);

    // Running it again checks the ENS name proof
    const result4 = await job.doJobs();
    expect(result4.isOk()).toBe(true);
    expect(result4._unsafeUnwrap()).toBe(1);
  });
});
