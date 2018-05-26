# ratp-stops-indexer

Load RATP open data into Algolia for a better search experience.

## Install

```
npm i -g ratp-stops-indexer
```

## Prerequisites

* Node >=10
* RATP lines Open Data. Can be found [here](http://dataratp.download.opendatasoft.com/RATP_GTFS_LINES.zip). Need to be unziped.
* ALGOLIA_APP_ID & ALGOLIA_API_KEY as env variables

## Usage

* Basic:

```
ratp-stops-indexer --gtfs <path_to_RATP_GTFS_LINES_directory>
```

* Save ratp lines parsing result in case of indexing failure

```
ratp-stops-indexer --gtfs <path_to_RATP_GTFS_LINES_directory> --saveFile <path_to_json_file>
```

* Save parsing result & dump indexing errors in a file (useful because errors are not easily readable in the terminal)

```
ratp-stops-indexer --gtfs <path_to_RATP_GTFS_LINES_directory> --saveFile <path_to_json_file> --errorFile <path_to_err_json_file>
```

* Skip parsing & load previous parsing result

```
ratp-stops-indexer  --saveFile <path_to_json_file> --fromSave
```
