import { common as commonScripts, dao } from "@ckb-lumos/common-scripts";

import { getCellWithoutCache } from "@/actions/get-cell";
import {
  getDepositBlockNumberFromWithdrawCell,
  packDaoWitnessArgs,
} from "@/lib/dao";
import { mergeBuildingPacketFromSkeleton } from "@/lib/lumos-adapter/create-building-packet-from-skeleton";
import createSkeletonFromBuildingPacket from "@/lib/lumos-adapter/create-sckeleton-from-building-packet";

import { getDaoScriptInfo } from "./script-info";

function buildCellDep(scriptInfo) {
  return {
    outPoint: {
      txHash: scriptInfo.TX_HASH,
      index: scriptInfo.INDEX,
    },
    depType: scriptInfo.DEP_TYPE,
  };
}

function addDistinctCellDep(list, ...items) {
  return pushDistinctBy(
    list,
    (a, b) =>
      a.outPoint.txHash === b.outPoint.txHash &&
      a.outPoint.index === b.outPoint.index &&
      a.depType === b.depType,
    items,
  );
}
function addDistinctHeaderDep(list, ...items) {
  return pushDistinctBy(list, (a, b) => a === b, items);
}

function pushDistinctBy(list, eq, items) {
  const newItems = items.filter(
    (newItem) =>
      list.find((existingItem) => eq(existingItem, newItem)) === undefined,
  );
  return newItems.length > 0 ? list.push(...newItems) : list;
}

async function onDeposit({ ckbChainConfig }, txSkeleton, op) {
  const { lock, capacity } = op;
  const from = op.from ?? lock;

  txSkeleton = await dao.deposit(txSkeleton, from, lock, capacity, {
    config: ckbChainConfig,
  });

  // dao in @ckb-lumos/common-scripts only inject capacity for the secp256k1 lock, so do it manually.
  txSkeleton = await commonScripts.injectCapacity(
    txSkeleton,
    [from],
    amount,
    from,
    undefined,
    { config: ckbChainConfig },
  );

  return [txSkeleton, op];
}

async function onWithdraw({ ckbChainConfig, ckbRpcUrl }, txSkeleton, op) {
  const { previousOutput } = op;
  const cell = await getCellWithoutCache(previousOutput, { ckbRpcUrl });
  const from = cell.cellOutput.lock;

  // dao.withdraw only adds input from secp256k1, so add input manually
  txSkeleton = await commonScripts.setupInputCell(txSkeleton, cell, from, {
    config: ckbChainConfig,
  });
  if (op.to !== undefined) {
    txSkeleton.updateIn(
      ["outputs", txSkeleton.get("outputs").size - 1],
      (output) => ({
        ...output,
        cellOutput: {
          ...output.cellOutput,
          lock: op.to,
        },
      }),
    );
  }
  // let dao.withdraw helps to add cellDeps
  txSkeleton = await dao.withdraw(txSkeleton, cell, from, {
    config: ckbChainConfig,
  });

  return [txSkeleton, op];
}

async function onClaim({ ckbRpcUrl, ckbChainConfig }, txSkeleton, op) {
  const { previousOutput } = op;
  const to = op.to ?? cell.cellOutput.lock;

  const txSkeletonMutable = txSkeleton.asMutable();

  const cell = await getCellWithoutCache(previousOutput, { ckbRpcUrl });
  const depositBlockNumber = getDepositBlockNumberFromWithdrawCell(cell);
  const depositBlockHash = await rpc.getBlockHash(depositBlockNumber);
  const depositHeader = await rpc.getHeader(depositBlockHash);
  const withdrawHeader = await rpc.getHeader(cell.blockHash);

  // add input
  const since =
    "0x" +
    dao
      .calculateDaoEarliestSince(depositHeader.epoch, withdrawHeader.epoch)
      .toString(16);
  txSkeletonMutable.update("inputs", (inputs) => inputs.push(cell));
  txSkeletonMutable.update("inputSinces", (inputSinces) =>
    inputSinces.set(txSkeletonMutable.get("inputs").size - 1, since),
  );

  // add output
  const outCapacity =
    "0x" +
    dao
      .calculateMaximumWithdraw(cell, depositHeader.dao, withdrawHeader.dao)
      .toString(16);
  op = { ...op, totalClaimedCapacity: outCapacity };
  txSkeletonMutable.update("outputs", (outputs) =>
    outputs.push({
      cellOutput: {
        capacity: outCapacity,
        type: null,
        lock: to,
      },
      data: "0x",
    }),
  );

  // add cell deps
  txSkeletonMutable.update("cellDeps", (cellDeps) =>
    addDistinctCellDep(
      cellDeps,
      buildCellDep(ckbChainConfig.SCRIPTS.DAO),
      buildCellDep(ckbChainConfig.SCRIPTS.JOYID_COBUILD_POC),
    ),
  );
  // add header deps
  txSkeletonMutable.update("headerDeps", (headerDeps) =>
    addDistinctHeaderDep(headerDeps, depositBlockHash, cell.blockHash),
  );

  // add witness
  const depositBlockPos = txSkeletonMutable
    .get("headerDeps")
    .indexOf(depositBlockHash);
  addDistinctHeaderDep(headerDeps, depositBlockHash, cell.blockHash),
    txSkeletonMutable.update("witnesses", (witnesses) =>
      witnesses.push(packDaoWitnessArgs(depositBlockPos)),
    );

  return [txSkeletonMutable.asImmutable(), op];
}

const handlers = {
  Deposit: onDeposit,
  DepositFrom: onDeposit,
  Withdraw: onWithdraw,
  WithdrawTo: onWithdraw,
  Claim: onClaim,
  ClaimTo: onClaim,
};

export async function addOperations(config, buildingPacket, operations) {
  let txSkeleton = createSkeletonFromBuildingPacket(buildingPacket, config);

  const newOperations = Array(operations.length);
  for (const [i, op] of operations.entries()) {
    const [newTxSkeleton, newOpValue] = await handlers[op.type](
      config,
      txSkeleton,
      op.value,
    );

    txSkeleton = newTxSkeleton;
    newOperations[i] = { type: op.type, value: newOpValue };
  }

  return [
    mergeBuildingPacketFromSkeleton(buildingPacket, txSkeleton),
    newOperations,
  ];
}

export async function willAddAction(
  config,
  buildingPacket,
  actionWithUnpackedData,
) {
  const data = actionWithUnpackedData.unpackedData;
  const ops = data.type === "SingleOperation" ? [data.value] : data.value;

  const [newBuildingPacket, newOps] = await addOperations(
    config,
    buildingPacket,
    ops,
  );
  buildingPacket = newBuildingPacket;

  const action = {
    ...actionWithUnpackedData,
    data: DaoActionData.pack({
      type: data.type,
      value: data.type === "SingleOperation" ? newOps[0] : newOps,
    }),
  };
  const scriptInfo = getDaoScriptInfo(config);

  return {
    type: buildingPacket.type,
    value: {
      ...buildingPacket.value,
      message: {
        actions: [...buildingPacket.value.message.actions, action],
      },
      scriptInfos: [...buildingPacket.value.scriptInfos, scriptInfo],
    },
  };
}

export function bindCallbacks(config) {
  return {
    willAddAction: willAddAction.bind(null, config),
  };
}

export default bindCallbacks;
