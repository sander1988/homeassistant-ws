import EventEmitter from 'events';
import WebSocket from 'isomorphic-ws';

export type HassWsOptions = {
  protocol: 'ws' | 'wss';
  host: string;
  port: number;
  path: string;
  token: string;
  messageSerializer: (outgoingMessage: any) => string;
  messageParser: (incomingMessage: MessageEvent) => any;
  ws: (opts: HassWsOptions) => WebSocket;
};

type HassClient = {
  seq: number;
  options: HassWsOptions;
  resultMap: { [resultId: number]: any };
  emitter: EventEmitter;
  ws: WebSocket;
};

type HassCommandArgs = {
  type:
    | 'call_service'
    | 'subscribe_events'
    | 'get_states'
    | 'get_services'
    | 'get_panels'
    | 'get_config'
    | 'config/area_registry/list'
    | 'config/device_registry/list'
    | 'config/entity_registry/list'
    | 'config/entity_registry/get'
    | 'media_player_thumbnail'
    | 'auth/sign_path'
    | 'camera_thumbnail'
    | 'camera/stream'
    | 'logbook/get_events'
    | 'history/history_during_period'
    | 'history/statistics_during_period';

  [additionalArg: string]: any;
};

export type EventListener = (...args: any[]) => void;
export type EventType = string | symbol;

export type HassApi = {
  rawClient: HassClient;
  getStates: () => Promise<any[]>;
  getServices: () => Promise<any[]>;
  getPanels: () => Promise<any[]>;
  getConfig: () => Promise<{}>;
  getAreas: () => Promise<[]>;
  getDevices: () => Promise<[]>;
  getEntities: () => Promise<[]>;
  getEntity: (entityId: string) => Promise<{}>;
  getMediaPlayerThumbnail: (entityId: string) => Promise<{}>;
  signPath: (path: string, expires?: number) => Promise<{}>;
  getCameraThumbnail: (entityId: string) => Promise<{}>;
  getCameraStream: (entityId: string, format: string) => Promise<{}>;
  getLogbookEvents: (startTime: string, endTime?: string, entityIds?: string[], deviceIds?: string[]) => Promise<{}>;
  getEntityHistory: (startTime: string, endTime?: string, entityIds?: string[], includeStartTimeState?: boolean, significantChangesOnly?: boolean, minimalResponse?: boolean, noAttributes?: boolean) => Promise<{}>;
  getEntityStatistics: (period: '5minute'|'hour'|'day'|'month', startTime: string, endTime?: string, statisticIds?: string[]) => Promise<{}>;

  on: (eventType: EventType, cb: EventListener) => void;

  callService: (
    domain: string,
    service: string,
    extraArgs?: any
  ) => Promise<any>;
};

const defaultOptions: Partial<HassWsOptions> = {
  protocol: 'ws',
  host: 'localhost',
  port: 8123,
  path: '/api/websocket',

  messageSerializer: (outgoingMessage: any) => JSON.stringify(outgoingMessage),
  messageParser: (incomingMessage: { data: string }) =>
    JSON.parse(incomingMessage.data),

  // A method that returns a websocket instance. Can be overriden to use a custom behavior:
  ws: (opts: HassWsOptions) => {
    return new WebSocket(
      `${opts.protocol}://${opts.host}:${opts.port}${opts.path}`
    );
  },
};

const command = async (
  commandArgs: HassCommandArgs,
  client: HassClient
): Promise<any> => {
  return new Promise((resolve, reject) => {
    const id = client.seq;

    client.resultMap[id] = (resultMessage: any) => {
      if (resultMessage.success) resolve(resultMessage.result);
      else reject(new Error(resultMessage.error.message));

      // We won't need this callback again once we use it:
      delete client.resultMap[id];
    };

    client.ws.send(
      client.options.messageSerializer({
        ...commandArgs,
        id,
      })
    );

    // Increment the shared message id sequence:
    client.seq++;
  });
};

const binaryResultTransform = (result: any) => {
  return {
    content_type: result.content_type,
    content: Buffer.from(result.content, 'base64'),
  };
};

const messageHandler = (client: HassClient) => {
  return (wsMessage: MessageEvent) => {
    const message = client.options.messageParser(wsMessage);

    // Emit an event for any message under a main 'message' listener:
    client.emitter.emit('message', message);

    // Emit an event for any message of any type:
    if (message.type) client.emitter.emit(message.type, message);

    // Emit an event for event-type messages:
    if (message.type === 'event' && message.event.event_type) {
      client.emitter.emit(message.event.event_type, message.event);
    }

    // If this is a result message, match it with the results map on the client
    // and call the matching function:
    if (message.id && message.type === 'result') {
      if (typeof client.resultMap[message.id] !== 'undefined') {
        client.resultMap[message.id](message);
      }
    }
  };
};

const clientObject = (client: HassClient): HassApi => {
  return {
    rawClient: client,

    getStates: async () => command({ type: 'get_states' }, client),
    getServices: async () => command({ type: 'get_services' }, client),
    getPanels: async () => command({ type: 'get_panels' }, client),
    getConfig: async () => command({ type: 'get_config' }, client),
    getAreas: async () => command({ type: 'config/area_registry/list' }, client),
    getDevices: async () => command({ type: 'config/device_registry/list' }, client),
    getEntities: async () => command({ type: 'config/entity_registry/list' }, client),

    on: (eventId: EventType, cb: EventListener): void => {
      client.emitter.on(eventId, cb);
    },

    async callService(domain, service, additionalArgs = {}) {
      return command(
        {
          type: 'call_service',
          domain,
          service,
          service_data: additionalArgs,
        },
        client
      );
    },
    
    async getEntity(entityId) {
      return command(
        {
          type: 'config/entity_registry/get',
          entity_id: entityId,
        },
        client
      );
    },

    async getMediaPlayerThumbnail(entityId) {
      return command(
        {
          type: 'media_player_thumbnail',
          entity_id: entityId,
        },
        client
      ).then(binaryResultTransform);
    },
    
    async signPath(path, expires=30) {
      return command(
        {
          type: 'auth/sign_path',
          path: path,
          expires: expires,
        },
        client
      );
    },

    async getCameraThumbnail(entityId) {
      return command(
        {
          type: 'camera_thumbnail',
          entity_id: entityId,
        },
        client
      ).then(binaryResultTransform);
    },
    
    async getCameraStream(entityId, format='hls') {
      return command(
        {
          type: 'camera/stream',
          entity_id: entityId,
          format: format,
        },
        client
      );
    },
    
    async getLogbookEvents(startTime, endTime, entityIds, deviceIds) {
      return command(
        {
          type: 'logbook/get_events',
          start_time: startTime,
          end_time: endTime,
          entity_ids: entityIds,
          device_ids: deviceIds,
        },
        client
      );
    },
    
    async getEntityHistory(startTime, endTime, entityIds, includeStartTimeState=true, significantChangesOnly=true, minimalResponse=false, noAttributes=false) {
      return command(
        {
          type: 'history/history_during_period',
          start_time: startTime,
          end_time: endTime,
          entity_ids: entityIds,
          include_start_time_state: includeStartTimeState,
          significant_changes_only: significantChangesOnly,
          minimal_response: minimalResponse,
          no_attributes: noAttributes,
        },
        client
      );
    },
      
    async getEntityStatistics(period, startTime, endTime, statisticIds) {
      return command(
        {
          type: 'history/statistics_during_period',
          start_time: startTime,
          end_time: endTime,
          statistic_ids: statisticIds,
          period: period,
        },
        client
      );
    },    
  };
};

const connectAndAuthorize = async (
  client: HassClient
): Promise<HassApi> => {
  return new Promise((resolve, reject) => {
    client.ws.onmessage = messageHandler(client);

    client.ws.onerror = (err: Error) => {
      // Unlikely for a listener to exist at this stage, but just in case:
      client.emitter.emit('ws_error', err);
      reject(err);
    };

    // Pass-through onclose events to the client:
    client.ws.onclose = (event: CloseEvent) =>
      client.emitter.emit('ws_close', event);

    client.emitter.on('auth_ok', () => {
      // Immediately subscribe to all events, and return the client handle:
      command({ type: 'subscribe_events' }, client)
        .then(() => resolve(clientObject(client)))
        .catch((err) => reject(err));
    });

    client.emitter.on('auth_invalid', (msg: { message: string }) =>
      reject(new Error(msg.message))
    );
    client.emitter.on('auth_required', () => {
      // If auth is required, immediately reject the promise if no token was provided:
      if (!client.options.token) {
        reject(
          new Error(
            'Homeassistant requires authentication, but token not provided in options'
          )
        );
      }

      client.ws.send(
        client.options.messageSerializer({
          type: 'auth',
          access_token: client.options.token,
        })
      );
    });
  });
};

export default async function createClient(
  callerOptions: Partial<HassWsOptions> = {}
): HassClient {
  const options = {
    ...defaultOptions,
    ...callerOptions,
  } as HassWsOptions;

  const client: HassClient = {
    seq: 1,
    options,
    resultMap: {},
    emitter: new (EventEmitter as any)(),
    ws: options.ws(options),
  };

  return client
}
