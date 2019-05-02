#!/usr/bin/env node
const { promises: fs, createReadStream } = require('fs');
const { Transform } = require('stream');
const path = require('path');
const uuid = require('uuid/v4');
const ProgressBar = require('ascii-progress');
const algolia = require('algoliasearch');
const { argv } = require('yargs');

const isMain = !module.parent;
const { gtfs, saveFile, errorFile, fromSave } = argv;
const { ALGOLIA_APP_ID, ALGOLIA_API_KEY } = process.env;

const client = algolia(ALGOLIA_APP_ID, ALGOLIA_API_KEY);
const INDEX = 'ratp_stops';
const STOPS_FILENAME = 'stops.txt';
const ROUTES_FILENAME = 'routes.txt';
const TRIPS_FILENAME = 'trips.txt';
const STOPS_TIMES_FILENAME = 'stop_times.txt';
const TRANSFERS_FILENAME = 'transfers.txt';

const sliceCall = (action, list, chunkSize = 100) => {
  let chain = Promise.resolve();
  const items = [...list];
  const results = [];
  const bar = new ProgressBar({
    total: list.length,
    schema: ' |:bar| :current/:total :percent :elapseds :etas',
  });
  while (items.length) {
    const chunk = items.splice(0, chunkSize);
    chain = chain
      .then(() => action(chunk))
      .then(result => {
        results.push(result);
        bar.tick(chunkSize);
      });
  }
  return chain.then(() => results);
};

const writeInIndex = lines => {
  const stops = lines.reduce(
    (acc, line) =>
      acc.concat(
        line.stops.map(stop => ({
          action: 'addObject',
          indexName: INDEX,
          body: {
            ...stop,
            line: line.name,
            type: line.type,
            // To avoid duplicates on ratp lines update
            objectID: stop.providerId,
          },
        })),
      ),
    [],
  );
  console.log(`${stops.length} entities will be written in index`);
  return sliceCall(client.batch.bind(client), stops, 500);
};

const join = parentDir => dirname => path.join(parentDir, dirname);
const getSplitStream = () =>
  new Transform({
    objectMode: true,
    transform(chunk, encoding, cb) {
      this.last = (this.last || '') + chunk;
      const lines = this.last.split(/\r?\n/);
      this.last = lines.pop();
      lines.forEach(line => this.push(line));
      cb();
    },
  });

const getLines = async DATA_DIRECTORY => {
  const linesDir = (await fs.readdir(DATA_DIRECTORY, { encoding: 'utf8' })).map(
    join(DATA_DIRECTORY),
  );
  const bar = new ProgressBar({
    total: linesDir.length,
    schema: ' |:bar| :current/:total :percent :elapseds :etas :name',
  });
  // Map stopId to transfers
  const mapStopTransfers = {};
  // Map location (latitude:longitude) to stops
  const mapLocationStops = {};
  const lines = await Promise.all(
    linesDir.map(async lineDir => {
      // Get routes
      const routes = (await fs.readFile(
        path.join(lineDir, ROUTES_FILENAME),
        'utf8',
      ))
        .split(/\r?\n/)
        .slice(1, -1)
        .reduce((map, item) => {
          const [
            route_id,
            _agency_id,
            _route_short_name,
            route_long_name,
            _route_desc,
            _route_type,
            _route_url,
            _route_color,
            _route_text_color,
          ] = item.split(',');
          return {
            ...map,
            [route_id]: {
              routeId: route_id,
              way: route_long_name.includes('Aller') ? 'outward' : 'return',
            },
          };
        }, {});
      // Map tripId to routeId
      const mapTripsRoutes = {};
      const streamTrips = createReadStream(path.join(lineDir, TRIPS_FILENAME), {
        encoding: 'utf8',
      }).pipe(getSplitStream());
      for await (const line of streamTrips) {
        const [
          route_id,
          _service_id,
          trip_id,
          _trip_headsign,
          _trip_short_name,
          _direction_id,
          _shape_id,
        ] = line.split(',');
        mapTripsRoutes[trip_id] = route_id;
      }
      // Map stops to routeId
      const mapStationsRoutes = {};
      const streamTimes = createReadStream(
        path.join(lineDir, STOPS_TIMES_FILENAME),
        {
          encoding: 'utf8',
        },
      ).pipe(getSplitStream());
      for await (const line of streamTimes) {
        const [
          trip_id,
          _arrival_time,
          _departure_time,
          stop_id,
          _stop_sequence,
          _stop_headsign,
          _shape_dist_traveled,
        ] = line.split(',');
        mapStationsRoutes[stop_id] = mapTripsRoutes[trip_id];
      }

      const streamTransfers = createReadStream(
        path.join(lineDir, TRANSFERS_FILENAME),
        {
          encoding: 'utf8',
        },
      ).pipe(getSplitStream());
      for await (const line of streamTransfers) {
        const [from_stop_id, to_stop_id] = line.split(',');
        if (!mapStopTransfers[from_stop_id]) {
          mapStopTransfers[from_stop_id] = [];
        }
        if (!mapStopTransfers[to_stop_id]) {
          mapStopTransfers[to_stop_id] = [];
        }
        mapStopTransfers[from_stop_id].push(to_stop_id);
        mapStopTransfers[to_stop_id].push(from_stop_id);
      }

      const stream = createReadStream(path.join(lineDir, STOPS_FILENAME), {
        encoding: 'utf8',
      }).pipe(getSplitStream());
      const stops = [];
      const mapStopIndex = new Map();
      for await (const line of stream) {
        const [
          stop_id,
          stop_code,
          stop_name,
          stop_desc,
          stop_lat,
          stop_lon,
          location_type,
          parent_station,
        ] = line.split(',');
        // In stops.txt, stop names are quoted
        const name = stop_name.replace(/"/g, '');
        // First line, drop headers
        if (stop_id !== 'stop_id') {
          const routeId = mapStationsRoutes[stop_id];
          if (mapStopIndex.has(name)) {
            const index = mapStopIndex.get(name);
            stops[index].locations.push({
              description: stop_desc,
              latitude: stop_lat,
              longitude: stop_lon,
              way: routeId ? routes[routeId].way : null,
              // ??
              locationType: location_type,
            });
          } else {
            stops.push({
              id: uuid(),
              name,
              locations: [
                {
                  description: stop_desc,
                  latitude: stop_lat,
                  longitude: stop_lon,
                  way: routeId ? routes[routeId].way : null,
                  // ??
                  locationType: location_type,
                },
              ],
              transfers: mapStopTransfers[stop_id],
              // ??
              parentStation: parent_station,
              providerId: stop_id,
              // ??
              providerCode: stop_code,
            });
            mapStopIndex.set(name, stops.length - 1);
          }
          // Add to location map
          const location = `${stop_lat}:${stop_lon}`;
          mapLocationStops[location] = (
            mapLocationStops[location] || []
          ).concat(stop_id);
        }
      }
      const [, , type, name] = path.basename(lineDir).split('_');
      bar.tick({
        name: `${type} ${name}`,
      });
      // Line
      return {
        id: uuid(),
        name,
        type,
        stops,
        providerId: `${type}_${name}`,
      };
    }),
  );
  // Add missing transfers from locations & transitive transfers
  return lines.map(line => ({
    ...line,
    stops: line.stops.map(stop => {
      const directTransfers = mapStopTransfers[stop.providerId] || [];
      const transitiveTransfers = directTransfers.reduce(
        (acc, transfer) => [...acc, ...(mapStopTransfers[transfer] || [])],
        [],
      );
      return {
        ...stop,
        transfers: Array.from(
          new Set([
            ...directTransfers,
            ...transitiveTransfers,
            ...stop.locations.reduce(
              (acc, location) => [
                ...acc,
                ...(mapLocationStops[
                  `${location.latitude}:${location.longitude}`
                ] || []),
              ],
              [],
            ),
          ]),
        ).filter(transfer => transfer !== stop.providerId),
      };
    }),
  }));
};

const run = async ({
  gtfs: DATA_DIRECTORY,
  saveFile: savePath,
  errorFile: errorPath,
  fromSave: useSave,
}) => {
  try {
    const lines = useSave
      ? await fs.readFile(savePath, 'utf8').then(data => JSON.parse(data).lines)
      : await getLines(DATA_DIRECTORY) // Dump lines in case of indexing failure
          .then(async result => {
            if (saveFile) {
              await fs.writeFile(
                saveFile,
                JSON.stringify({ lines: result }, null, 2),
                'utf8',
              );
            }
            return result;
          });
    const result = await writeInIndex(lines);
    if (isMain) {
      console.log('Done');
      console.log(`${result.length} entities created in index`);
    }
  } catch (e) {
    if (isMain) {
      console.error(e);
    }
    if (errorPath) {
      await fs.writeFile(errorPath, JSON.stringify(e, 2, null), 'utf8');
    }
    throw e;
  }
};

if (isMain) {
  run({
    gtfs,
    saveFile,
    errorFile,
    fromSave,
  }).catch();
}

module.exports = run;
