'use strict'

let test = require('tape')
let fse = require('fs-extra')

require('ngn')
require('ngn-data')
require('../')

let root = require('path').join(__dirname, './data')

fse.emptyDirSync(root)

let meta = function () {
  return {
    idAttribute: 'testid',
    fields: {
      firstname: null,
      lastname: null,
      val: {
        min: 10,
        max: 20,
        default: 15
      }
    }
  }
}

let createPetSet = function () {
  let Pet = new NGN.DATA.Model({
    fields: {
      name: null,
      breed: null
    }
  })

  let m = meta()

  m.relationships = {
    pet: Pet
  }

  let NewModel = new NGN.DATA.Model(m)
  let dataset = new NGN.DATA.Store({
    model: NewModel,
    proxy: new NGNX.DATA.LevelDBProxy(root)
  })

  dataset.add({
    firstname: 'The',
    lastname: 'Doctor',
    pet: {
      name: 'K-9',
      breed: 'Robodog'
    }
  })

  dataset.add({
    firstname: 'The',
    lastname: 'Master',
    pet: {
      name: 'Drums',
      breed: '?'
    }
  })

  return dataset
}

test('Primary Namespace', function (t) {
  t.ok(NGNX.DATA.LevelDBProxy !== undefined, 'NGNX.DATA.LevelDBProxy is defined globally.')
  t.end()
})

test('Self Inspection', function (t) {
  let m = meta()
  let NewModel = new NGN.DATA.Model(m)
  let dataset = new NGN.DATA.Store({
    model: NewModel,
    proxy: new NGNX.DATA.LevelDBProxy(root)
  })

  t.ok(dataset.proxy.type === 'store', 'Recognized store.')

  m.proxy = new NGNX.DATA.LevelDBProxy(root)

  let TestRecord = new NGN.DATA.Model(m)
  let rec = new TestRecord({
    firstname: 'The',
    lastname: 'Doctor'
  })

  t.ok(rec.proxy.type === 'model', 'Recognized model.')
  t.end()
})

test('Basic Save & Fetch (Data Model)', function (t) {
  let Pet = new NGN.DATA.Model({
    fields: {
      name: null,
      breed: null
    }
  })

  let m = meta()

  m.relationships = {
    pet: Pet
  }

  m.proxy = new NGNX.DATA.LevelDBProxy(root)

  let DataRecord = new NGN.DATA.Model(m)
  let record = new DataRecord({
    firstname: 'The',
    lastname: 'Doctor',
    pet: {
      name: 'K-9',
      breed: 'Robodog'
    }
  })

  record.once('field.update', function (change) {
    record.save(() => {
      t.pass('Save method applies callback.')

      record.lastname = 'Master'

      t.ok(record.lastname === 'Master', 'Changes apply normally.')

      record.fetch(() => {
        t.pass('Fetch method applies callback.')
        t.ok(record.lastname === 'Doctor', 'Data accurately loaded from disk.')
        t.ok(record.pet.name === 'K-9', 'Properly retrieved nested model data.')

        fse.emptyDirSync(root)
        t.end()
      })
    })
  })

  record.firstname = 'Da'
})

test('Basic Save & Fetch (Data Store)', function (t) {
  let ds = createPetSet()

  ds.once('record.update', function (record, change) {
    ds.save(() => {
      t.pass('Save method applies callback.')

      ds.fetch(() => {
        t.pass('Fetch method applies callback.')
        t.ok(ds.first.lastname === 'Doctor' &&
          ds.last.lastname === 'Master' &&
          ds.last.firstname === 'Da' &&
          ds.first.pet.name === 'K-9',
        'Successfully retrieved modified results.')

        fse.emptyDirSync(root)
        t.end()
      })
    })
  })

  ds.last.firstname = 'Da'
})

test('Store Array Values', function (t) {
  let Model = new NGN.DATA.Model({
    fields: {
      a: Array
    },
    proxy: new NGNX.DATA.LevelDBProxy(root)
  })

  let record = new Model({
    a: ['a', 'b', 'c', {d: true}]
  })

  record.save(() => {
    t.pass('Saved array data.')
    record.a = []

    record.fetch(() => {
      t.pass('Retrieved array data.')

      t.ok(Array.isArray(record.a), 'Record returned in array format.')
      t.ok(typeof record.a.pop() === 'object' && record.a[0] === 'a', 'Array data is in correct format.')

      fse.emptyDirSync(root)

      t.end()
    })
  })
})

test('Non-String Primitive Data Types', function (t) {
  let Model = new NGN.DATA.Model({
    fields: {
      b: Boolean,
      n: Number,
      nil: null,
      o: Object
    },
    proxy: new NGNX.DATA.LevelDBProxy(root)
  })

  let record = new Model({
    b: false,
    n: 3,
    o: {
      some: 'value'
    }
  })

  record.save(() => {
    record.b = true

    record.fetch(() => {
      t.ok(record.b === false, 'Boolean supported.')
      t.ok(record.n === 3, 'Number supported.')
      t.ok(record.nil === null, 'Null supported.')
      t.ok(record.o.some === 'value', 'Object/JSON supported for models.')
      t.end()
    })
  })
})
