'use strict'

const fastify = require('../fastify')()

fastify
  .addHook('onRequest', function uncino (request, reply, next) {
    console.log('onRequest')
    next()
  })

fastify.register(function eng (instance, options, next) {
  // the route will be '/english/hello'
  instance.get('/hello', function hello (req, reply) {
    reply.send({ greet: 'hello' })
  })
  next()
}, { prefix: '/english' })

fastify.register(function ita (instance, options, next) {
  // the route will be '/italian/hello'
  instance.get('/hello', function ciao (req, reply) {
    reply.send({ greet: 'ciao' })
  })

  fastify.register(function dialect (instance, options, next) {
    instance.get('/hello', function saludi (req, reply) {
      reply.send({ greet: 'saludi' })
    })
    next()
  }, { prefix: '/dialect' })

  next()
}, { prefix: '/italian' })

fastify.listen(8000, function (err) {
  if (err) {
    throw err
  }
  console.log(`server listening on ${fastify.server.address().port}`)
  console.log(fastify.toString())
})
