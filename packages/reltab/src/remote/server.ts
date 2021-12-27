/**
 * Top-level, transport-agnostic async entry points for reltab as a
 * remote service.
 */

import * as log from "loglevel";
import * as prettyHRTime from "pretty-hrtime";
import {
  EngineReq,
  DbConnEvalQueryRequest,
  DbConnRowCountRequest,
  DbConnGetTableInfoRequest,
  DbConnGetChildrenRequest,
  DbConnGetTableNameRequest,
} from "./Connection";
import {
  DataSourceConnection,
  DataSourceId,
  DataSourceNode,
  DataSourcePath,
  DataSourceProvider,
} from "../DataSource";
import { deserializeQueryReq, QueryExp } from "../QueryExp";
import {
  EncodedRequestHandler,
  TransportClient,
  TransportServer,
} from "./Transport";
import { TableInfo, TableRep } from "../TableRep";
import { Result } from "./result";
import { serializeError } from "serialize-error";

const dbConnEvalQuery = async (
  conn: DataSourceConnection,
  req: DbConnEvalQueryRequest
): Promise<TableRep> => {
  const query = deserializeQueryReq(req.queryStr) as any;
  const hrstart = process.hrtime();
  const offset = req.offset ? req.offset : undefined;
  const limit = req.limit ? req.limit : undefined;
  const options = req.options ? req.options : undefined;
  const qres = await conn.evalQuery(query, offset, limit, options);
  const elapsed = process.hrtime(hrstart);
  log.info("runQuery: evaluated query in  ", prettyHRTime(elapsed));
  const qresStr = JSON.stringify(
    qres,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2
  );
  return qres;
};

const dbConnRowCount = async (
  conn: DataSourceConnection,
  req: DbConnRowCountRequest
): Promise<number> => {
  const query = deserializeQueryReq(req.queryStr) as any;
  const hrstart = process.hrtime();
  const count = await conn.rowCount(query, req.options);
  const elapsed = process.hrtime(hrstart);
  log.info("rowCount: evaluated query in", prettyHRTime(elapsed));
  return count;
};

const dbConnGetRootNode = async (
  conn: DataSourceConnection
): Promise<DataSourceNode> => {
  const hrstart = process.hrtime();
  const rootNode = await conn.getRootNode();
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetRootNode: evaluated in", prettyHRTime(elapsed));
  return rootNode;
};

const dbConnGetChildren = async (
  conn: DataSourceConnection,
  req: DbConnGetChildrenRequest
): Promise<DataSourceNode[]> => {
  const hrstart = process.hrtime();
  const { path } = req;
  const children = await conn.getChildren(path);
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetChildren: evaluated query in", prettyHRTime(elapsed));
  return children;
};

const dbConnGetTableName = async (
  conn: DataSourceConnection,
  req: DbConnGetTableNameRequest
): Promise<string> => {
  const hrstart = process.hrtime();
  const { path } = req;
  const tableName = await conn.getTableName(path);
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetTableName: evaluated query in", prettyHRTime(elapsed));
  return tableName;
};

const dbConnGetTableInfo = async (
  conn: DataSourceConnection,
  req: DbConnGetTableInfoRequest
): Promise<TableInfo> => {
  const hrstart = process.hrtime();
  const { tableName } = req;
  const tableInfo = await conn.getTableInfo(tableName);
  const elapsed = process.hrtime(hrstart);
  log.info("dbGetTableInfo: evaluated query in", prettyHRTime(elapsed));
  return tableInfo;
};

// an EngineReqHandler wraps a req in an EngineReq that carries an
// db engine identifier (DataSourceId) that is used to identify
// a particular Db instance for dispatching the Db request.

type EngineReqHandler<Req, Resp> = (req: EngineReq<Req>) => Promise<Resp>;

function mkEngineReqHandler<Req, Resp>(
  srvFn: (dbConn: DataSourceConnection, req: Req) => Promise<Resp>
): EngineReqHandler<Req, Resp> {
  const handler = async (ereq: EngineReq<Req>): Promise<Resp> => {
    const { engine, req } = ereq;
    const dbConn = await getConnection(engine);
    const res = srvFn(dbConn, req);
    return res;
  };
  return handler;
}

const handleDbConnEvalQuery = mkEngineReqHandler(dbConnEvalQuery);
const handleDbConnRowCount = mkEngineReqHandler(dbConnRowCount);
const handleDbConnGetRootNode = mkEngineReqHandler(dbConnGetRootNode);
const handleDbConnGetChildren = mkEngineReqHandler(dbConnGetChildren);
const handleDbConnGetTableName = mkEngineReqHandler(dbConnGetTableName);
const handleDbConnGetTableInfo = mkEngineReqHandler(dbConnGetTableInfo);

let providerRegistry: { [providerName: string]: DataSourceProvider } = {};

// Called during static initialization from linked provider library
export function registerProvider(provider: DataSourceProvider): void {
  providerRegistry[provider.providerName] = provider;
}

let instanceCache: { [key: string]: Promise<DataSourceConnection> } = {};

let resolvedConnections: DataSourceConnection[] = [];

/*
 * internal utility to record a DataSourceConnection in our connection cache
 * when the initial connection promise resolves.
 */
const saveOnResolve = async (
  pconn: Promise<DataSourceConnection>,
  hidden: boolean
): Promise<DataSourceConnection> => {
  const c = await pconn;
  if (!hidden) {
    resolvedConnections.push(c);
  }
  return c;
};

interface GetConnectionOptions {
  hidden: boolean; // hidden connections won't appear in getDataSources list
}

const defaultGetConnectionOptions: GetConnectionOptions = {
  hidden: false,
};

/**
 * Used to both populate and read from the instance cache
 *
 */
export async function getConnection(
  sourceId: DataSourceId,
  options?: GetConnectionOptions
): Promise<DataSourceConnection> {
  const opts = options ?? defaultGetConnectionOptions;
  const key = JSON.stringify(sourceId);
  let connPromise: Promise<DataSourceConnection> | undefined;
  connPromise = instanceCache[key];
  if (!connPromise) {
    const { providerName, resourceId } = sourceId;
    let provider: DataSourceProvider | undefined =
      providerRegistry[providerName];

    if (!provider) {
      throw new Error(
        `getConnection: no registered DataSourceProvider for provider name '${providerName}'`
      );
    }
    connPromise = saveOnResolve(provider.connect(resourceId), opts.hidden);
    instanceCache[key] = connPromise;
  }
  return connPromise;
}

const connectionNodeId = async (
  conn: DataSourceConnection
): Promise<DataSourceId> => {
  return conn.sourceId;
};

interface GetDataSourcesResult {
  dataSourceIds: DataSourceId[];
}

async function getDataSources(): Promise<DataSourceId[]> {
  const nodeIds: Promise<DataSourceId>[] =
    resolvedConnections.map(connectionNodeId);
  return Promise.all(nodeIds);
}

const handleGetDataSources = async (): Promise<GetDataSourcesResult> => {
  const hrstart = process.hrtime();
  const dataSourceIds = await getDataSources();
  const elapsed = process.hrtime(hrstart);
  log.info("getDataSources: evaluated in  ", prettyHRTime(elapsed));
  const resObj = {
    dataSourceIds,
  };
  return resObj;
};

/**
 * server side of getSourceInfo standalone function, which operates on absolute paths.
 */
interface GetSourceInfoRequest {
  path: DataSourcePath;
}

interface GetSourceInfoResult {
  sourceInfo: DataSourceNode;
}

type AnyReqHandler = (req: any) => Promise<any>;

type ResultReqHandler<T> = (req: any) => Promise<Result<T>>;

const exceptionHandler =
  (hf: AnyReqHandler): ResultReqHandler<any> =>
  async (req: any) => {
    try {
      const value = await hf(req);
      return { status: "Ok", value };
    } catch (errVal) {
      console.error("exceptionHandler caught error: ", errVal);
      return { status: "Err", errVal: serializeError(errVal) };
    }
  };

const simpleJSONHandler =
  (hf: AnyReqHandler): EncodedRequestHandler =>
  async (encodedReq: string): Promise<string> => {
    const req = JSON.parse(encodedReq);
    const resp = await hf(req);
    return JSON.stringify(
      resp,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    );
  };

export const serverInit = (ts: TransportServer) => {
  ts.registerInvokeHandler(
    "getDataSources",
    simpleJSONHandler(exceptionHandler(handleGetDataSources))
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.evalQuery",
    simpleJSONHandler(exceptionHandler(handleDbConnEvalQuery))
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.rowCount",
    simpleJSONHandler(exceptionHandler(handleDbConnRowCount))
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getRootNode",
    simpleJSONHandler(exceptionHandler(handleDbConnGetRootNode))
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getChildren",
    simpleJSONHandler(exceptionHandler(handleDbConnGetChildren))
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getTableName",
    simpleJSONHandler(exceptionHandler(handleDbConnGetTableName))
  );
  ts.registerInvokeHandler(
    "DataSourceConnection.getTableInfo",
    simpleJSONHandler(exceptionHandler(handleDbConnGetTableInfo))
  );
};
