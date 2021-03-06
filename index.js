'use strict'

/**
 * @class NGNX.DATA.LevelDbProxy
 * Persist NGN DATA stores using LevelDB.
 *
 * LevelDB is a key/value store, so it is not explicitly designed
 * for relational data or traditional records. The NGN.DATA package
 * _does_ represent data in a somewhat relational manner. To bridge
 * this gap, a common approach is flattening data (a key with a stringified
 * JSON object). LevelDB supports this, so this proxy attempts to implement
 * a few common practices. Some assumptions must be made in order to do this.
 *
 * The LevelDB proxy assumes an #NGN.DATA.Store represents a complete LevelDB
 * database/directory. When fetching data, the store is loaded with the full
 * contents of the LevelDB data. When saving, records are flattened into a
 * key/value manner where the key is the ID of a record and the value is the
 * raw JSON data of the record (including the ID).
 *
 * If this proxy is applied to a single #NGN.DATA.Model (instead of a Store),
 * it is assumed to represent the entire dataset. Instead of flattening the
 * model into a single key/value record, each datafield of the model is treated
 * as a record. As a result, the LevelDB will mirror the datafields of the model.
 * Complex model fields, such as nested models, will be flattened. In both cases,
 * LevelDB will store records where the key is the datafield name and the value
 * is the datafield value.
 */
class LevelDbProxy extends NGN.DATA.Proxy {
  constructor (config) {
    config = config || {}

    if (typeof config === 'string') {
      config = {
        directory: config
      }
    }

    if (!config.directory) {
      throw new Error('No database configuration detected.')
    }

    if (!NGN.util.pathReadable(config.directory)) {
      console.warn(config.directory + ' does not exist or cannot be found. It will be created automatically if any data operation is requested.')
    }

    super(config)

    Object.defineProperties(this, {
      /**
       * @cfg {string} directory
       * Path to the LevelDB database directory.
       */
      directory: NGN.const(config.directory),

      leveldb: NGN.privateconst(require('levelup'))
    })
  }

  op (fn) {
    // console.log('Opening LevelDB')
    let db = this.leveldb(this.directory)
    fn(db, function () {
      // console.log('Closing LevelDB')
      db.close()
    })
  }

  flatten (key, value) {
    return {
      type: 'put',
      key: key.toString(),
      value: value,
      keyEncoding: 'string',
      valueEncoding: 'json'
    }
  }

  format (data) {
    let results = []

    if (data) {
      if (Array.isArray(data)) {
        data.forEach((item, index) => {
          results.push(this.flatten(NGN.coalesce(item[this.idAttribute], index), item))
        })
      } else {
        Object.keys(data).forEach((attribute) => {
          results.push({
            type: 'put',
            key: attribute.toString().trim(),
            value: data[attribute] === null ? '#NIL' : data[attribute],
            keyEncoding: 'string',
            valueEncoding: Array.isArray(data[attribute]) ? 'json' : (typeof data[attribute] === 'object' ? 'json' : typeof data[attribute])
          })
        })
      }
    }

    return results
  }

  /**
   * @method save
   * Save data to the LevelDB file.
   * @param {function} [callback]
   * An optional callback executes after the save is complete. Receives no arguments.
   * @fires save
   * Fired after the save is complete.
   */
  save (callback) {
    require('leveldown').destroy(this.directory, () => {
      this.op((db, done) => {
        db.batch(this.format(this.store.data), () => {
          done()
          setTimeout(() => {
            this.emit('save')
            this.store.emit('save')
            if (NGN.isFn(callback)) {
              callback()
            }
          }, 10)
        })
      })
    })
  }

  /**
   * @method fetch
   * Automatically populates the store/record with the full set of
   * data from the LevelDB.
   * @param {function} [callback]
   * An optional callback executes after the fetch and parse is complete. Receives no arguments.
   * @fires fetch
   * Fired after the fetch and parse is complete.
   */
  fetch (callback) {
    if (this.type === 'store') {
      let dataset = []

      this.op((db, done) => {
        db.createValueStream({
          keyEncoding: 'number',
          valueEncoding: 'json'
        }).on('data', (data) => {
          dataset.push(data)
        })
        .on('error', (err) => {
          console.log(err)
          done()
          throw err
        })
        .on('end', () => {
          console.log(dataset)
          this.store.reload(dataset)
          done()
          setTimeout(callback, 10)
        })
      })
    } else {
      this.op((db, fetchcomplete) => {
        let keys = []
        console.log('??????')
        db.createKeyStream().on('data', (key) => {
          console.log('>>>>>>', key)
          if (this.hasOwnProperty(key)) {
            keys.push(key)
          }
        })
        .on('error', (err) => {
          fetchcomplete()
          throw err
        })
        .on('end', () => {
          fetchcomplete()

          keys = keys.map((key) => {
            return {
              key: key,
              type: this.getFieldType(key)
            }
          })

          let TaskRunner = require('shortbus')
          let tasks = new TaskRunner()
          let data = {}

          keys.forEach((item) => {
            tasks.add((next) => {
              this.op((database, finished) => {
                database.get(item.key, {
                  keyEncoding: 'string',
                  valueEncoding: item.type
                }, (err, value) => {
                  if (err) {
                    finished()
                    throw err
                  }

                  if (['string', 'number', 'boolean', 'object'].indexOf(item.type) >= 0) {
                    let type = this.getFieldType(item.key)

                    if (value.indexOf('#NIL') >= 0) {
                      value = null
                    } else if (type === 'boolean') {
                      value = value === 'true'
                    } else if (type === 'number') {
                      if (value.indexOf('.') < 0) {
                        value = parseInt(value, 10)
                      } else {
                        value = parseFloat(value)
                      }
                    } else if (type === 'object') {
                      value = JSON.parse(value)
                    }

                    type = null
                  }

                  data[item.key] = value
                  finished()
                  setTimeout(() => {
                    next()
                  }, 10)
                })
              })
            })
          })

          tasks.on('complete', () => {
            keys = null

            if (Object.keys(data).length > 0) {
              this.store.load(data)
            }

            setTimeout(callback, 20)
          })

          setTimeout(() => {
            db.close()
            tasks.run(true)
          }, 10)
        })
      })
    }
  }

  getFieldType (field) {
    let pattern = /function\s(.*)\(\).*/gi
    let type = 'json'

    if (!this.joins.hasOwnProperty(field)) {
      if (!this.fields.hasOwnProperty(field)) {
        console.warn(field + ' is not a field in the model.')
        return null
      }

      type = pattern.exec(this.fields[field].type.toString())
      type = NGN.coalesce(type, [null, 'string'])[1].toLowerCase()
    } else {
      return 'json'
    }

    return type === 'array' ? 'json' : type
  }

  parse (dataset) {
    if (this.type === 'store') {
      let base = new this.model() // eslint-disable-line new-cap
      let currentId = null
      let resultset = []
      let currentData = {}

      dataset.forEach((item) => {
        let keys = item.key.split('.')
        let id = keys.shift()

        if (currentId !== id) {
          if (currentId !== null) {
            resultset.push(currentData)
          }

          currentData = {}
          currentData[base.idAttribute] = id
          currentId = id
        }

        let key = keys.shift()
        if (keys.length === 0) {
          currentData[key] = item.value
        } else {
          currentData[key] = currentData[key] || {}
          key = currentData[key]
          while (keys.length > 0) {
            let newkey = keys.shift()
            key[newkey] = key[newkey] || (keys.length === 0 ? item.value : {})
          }
        }
      })

      if (Object.keys(currentData).length > 0) {
        resultset.push(currentData)
        currentData = null
      }
    }
  }

  /**
   * @method enableLiveSync
   * Live synchronization monitors the dataset for changes and immediately
   * commits them to the data storage system.
   * @fires live.create
   * Triggered when a new record is persisted to the data store.
   * @fires live.update
   * Triggered when a record modification is persisted to the data store.
   * @fires live.delete
   * Triggered when a record is removed from the data store.
   */
  enableLiveSync () {
    if (this.type === 'model') {
      this.on('field.create', (change) => {
        this.op((db, done) => {
          db.put(change.field, NGN.coalesce(this[change.field], this.fields[change.field].default, null), {
            keyEncoding: 'string',
            valueEncoding: this.getFieldType(change.field)
          }, (err) => {
            if (err) {
              done()
              throw err
            }

            done()
            setTimeout(() => {
              this.emit('live.create', change)
              this.store.emit('live.create', change)
            }, 10)
          })
        })
      })

      this.on('field.update', (change) => {
        this.op((db, done) => {
          let key = change.field
          let val = change.new
          let type = null

          if (change.join) {
            key = change.field.split('.')[0]
            val = this[key].data
            type = 'json'
          } else {
            type = this.getFieldType(change.field)
          }

          db.put(key, val, {
            keyEncoding: 'string',
            valueEncoding: type
          }, (err) => {
            if (err) {
              done()
              throw err
            }

            key = null
            val = null
            type = null

            done()
            setTimeout(() => {
              this.emit('live.update', change)
              this.store.emit('live.update', change)
            }, 10)
          })
        })
      })

      this.on('field.remove', (change) => {
        this.op((db, done) => {
          db.del(change.field, {
            keyEncoding: 'string',
            valueEncoding: this.getFieldType(change.field)
          }, (err) => {
            if (err) {
              done()
              throw err
            }

            done()
            setTimeout(() => {
              this.emit('live.delete', change)
              this.store.emit('live.delete', change)
            }, 10)
          })
        })
      })

      // relationship.create is unncessary because no data is available
      // when a relationship is created. All related data will trigger a
      // `field.update` event.
      this.on('relationship.remove', (change) => {
        this.op((db, done) => {
          db.del(change.field, (err) => {
            if (err) {
              throw err
            }

            done()
            setTimeout(() => {
              this.emit('live.delete', change)
              this.store.emit('live.delete', change)
            }, 10)
          })
        })
      })
    } else {
      // Persist new records
      this.on('record.create', (record) => {
        this.op((db, done) => {
          if (record[record.idAttribute] === null) {
            record.setSilent(record.idAttribute, NGN.DATA.util.GUID())
          }

          db.put(record[record.idAttribute].toString(), record.data, {
            keyEncoding: 'string',
            valueEncoding: 'json'
          }, (err) => {
            if (err) {
              throw err
            }

            done()
            setTimeout(() => {
              this.emit('live.create', record)
              this.store.emit('live.create', record)
            }, 10)
          })
        })
      })

      // Update existing records
      this.on('record.update', (record, change) => {
        this.op((db, done) => {
          db.put(record[record.idAttribute].toString(), record.data, {
            keyEncoding: 'string',
            valueEncoding: 'json'
          }, (err) => {
            if (err) {
              throw err
            }

            done()
            setTimeout(() => {
              this.emit('live.update', record)
              this.store.emit('live.update', record)
            }, 10)
          })
        })
      })

      // Remove old records
      this.on('record.delete', (record) => {
        this.op((db, done) => {
          db.del(record[record.idAttribute], {
            keyEncoding: 'string',
            valueEncoding: 'json'
          }, (err) => {
            if (err) {
              throw err
            }

            done() // eslint-disable-line

            setTimeout(() => {
              this.emit('live.delete', record)
              this.store.emit('live.delete', record)
            }, 10)
          })
        })
      })

      this.on('clear', () => {
        require('leveldown').destroy(this.directory, () => {
          this.emit('live.delete', null)
          this.store.emit('live.delete', null)
        })
      })
    }
  }
}

global.NGNX = NGN.coalesce(global.NGNX, {DATA: {}})
global.NGNX.DATA = NGN.coalesce(global.NGNX.DATA, {})
Object.defineProperty(global.NGNX.DATA, 'LevelDBProxy', NGN.const(LevelDbProxy))
