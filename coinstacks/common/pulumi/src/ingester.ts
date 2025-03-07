import { createHash } from 'crypto'
import { parse } from 'dotenv'
import { hashElement } from 'folder-hash'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as k8s from '@pulumi/kubernetes'
import { Input, output, Resource } from '@pulumi/pulumi'
import { buildAndPushImage, Config, hasTag } from './index'

export interface IngesterConfig {
  enableDatadogLogs?: boolean
}

// creates a hash of the content included in the final build image
const getHash = async (asset: string): Promise<string> => {
  const hash = createHash('sha1')

  // hash root level unchained files
  const { hash: unchainedHash } = await hashElement('../../../', {
    folders: { exclude: ['.*', '*'] },
    files: { include: ['package.json', 'lerna.json'] },
  })
  hash.update(unchainedHash)

  // hash contents of packages
  const { hash: packagesHash } = await hashElement('../../../packages', {
    folders: { include: ['**'], exclude: ['.*', 'dist', 'node_modules', 'pulumi'] },
    files: { include: ['*.ts', '*.json', 'Dockerfile'] },
  })
  hash.update(packagesHash)

  // hash contents of common-ingester
  const { hash: commonIngesterHash } = await hashElement('../../common/ingester', {
    folders: { include: ['**'], exclude: ['.*', 'dist', 'node_modules', 'pulumi'] },
    files: { include: ['*.ts', '*.json', 'Dockerfile'] },
  })
  hash.update(commonIngesterHash)

  // hash contents of asset-ingester
  const { hash: ingesterHash } = await hashElement(`../../${asset}/ingester`, {
    folders: { include: ['**'], exclude: ['.*', 'dist', 'node_modules', 'pulumi'] },
    files: { include: ['*.ts', '*.json', 'Dockerfile'] },
  })
  hash.update(ingesterHash)

  return hash.digest('hex')
}

export async function deployIngester(
  app: string,
  asset: string,
  provider: k8s.Provider,
  namespace: string,
  config: Pick<Config, 'ingester' | 'dockerhub' | 'isLocal'>,
  deployDependencies: Input<Array<Resource>> = []
): Promise<Array<k8s.apps.v1.Deployment> | undefined> {
  if (config.ingester === undefined) return

  const tier = 'ingester'
  const labels = { app, asset, tier }
  const name = `${asset}-${tier}`

  let imageName = 'mhart/alpine-node:14.16.0' // local dev image
  if (!config.isLocal) {
    const repositoryName = `${app}-${asset}-${tier}`
    const tag = await getHash(asset)

    imageName = `shapeshiftdao/${repositoryName}:${tag}` // default public image
    if (config.dockerhub) {
      const image = `${config.dockerhub.username}/${repositoryName}`
      const baseImageName = `${config.dockerhub.username}/unchained-base:latest`

      imageName = `${image}:${tag}` // configured dockerhub image

      if (!(await hasTag(image, tag))) {
        await buildAndPushImage({
          image,
          context: `../../${asset}/ingester`,
          auth: {
            password: config.dockerhub.password,
            username: config.dockerhub.username,
            server: config.dockerhub.server,
          },
          buildArgs: {
            BUILDKIT_INLINE_CACHE: '1',
            BASE_IMAGE: baseImageName, // associated base image for dockerhub user expected to exist
          },
          env: { DOCKER_BUILDKIT: '1' },
          tags: [tag],
          cacheFroms: [`${image}:${tag}`, `${image}:latest`, baseImageName],
        })
      }
    }
  }

  const secretEnvs = Object.keys(parse(readFileSync('../sample.env'))).map<k8s.types.input.core.v1.EnvVar>((key) => ({
    name: key,
    valueFrom: { secretKeyRef: { name: asset, key: key } },
  }))

  const volumes = config.isLocal ? [{ name: 'app', hostPath: { path: join(__dirname, '../../../../') } }] : undefined
  const volumeMounts = config.isLocal ? [{ name: 'app', mountPath: '/app' }] : undefined

  const topology = new k8s.batch.v1.Job(
    `${name}-declare-topology`,
    {
      metadata: {
        namespace: namespace,
        labels: labels,
      },
      spec: {
        backoffLimit: 4,
        template: {
          metadata: {
            namespace: namespace,
            labels: labels,
          },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: `${name}-declare-topology`,
                env: [...secretEnvs],
                image: imageName,
                command: config.isLocal
                  ? ['sh', '-c', 'yarn tsc && node dist/topology.js']
                  : ['node', 'dist/topology.js'],
                volumeMounts: volumeMounts,
                workingDir: `/app/coinstacks/${asset}/ingester`,
              },
            ],
            volumes: volumes,
          },
        },
      },
    },
    { provider, dependsOn: deployDependencies }
  )

  type Socket = {
    name: string
    path: string
    replicas: 0 | 1
  }

  type Worker = {
    name: string
    path: string
    replicas: number
  }

  type Workers = Array<Socket | Worker>

  const socket = (s: Socket): Socket => s
  const worker = (w: Worker): Worker => w

  const workers: Workers = [
    socket({ name: 'socket-new-transaction', path: 'sockets/newTransaction', replicas: 1 }),
    socket({ name: 'socket-new-block', path: 'sockets/newBlock', replicas: 1 }),
    worker({ name: 'worker-new-block', path: 'workers/newBlock', replicas: 1 }),
    worker({ name: 'worker-block', path: 'workers/block', replicas: 1 }),
    worker({ name: 'worker-txid', path: 'workers/txid', replicas: 1 }),
    worker({ name: 'worker-tx', path: 'workers/tx', replicas: 1 }),
    worker({ name: 'worker-address', path: 'workers/address', replicas: 1 }),
    worker({ name: 'worker-registry', path: 'workers/registry', replicas: 1 }),
  ]

  return workers.map((worker) => {
    const datadogAnnotation = config.ingester?.enableDatadogLogs
      ? {
          [`ad.datadoghq.com/${worker.name}.logs`]: `[{"source": "${app}", "service": "${name}", "tags":["${asset}", "${worker.name}"]}]`,
        }
      : {}

    const watch = ['../../../packages/*/dist/tsconfig.tsbuildinfo', '../../common/ingester/dist/tsconfig.tsbuildinfo']

    const localCommand = [
      'sh',
      '-c',
      `yarn ts-node-dev --max-old-space-size=1024 --watch ${watch.toString()} --respawn --transpile-only src/${
        worker.path
      }.ts`,
    ]

    const podSpec: k8s.types.input.core.v1.PodTemplateSpec = {
      metadata: {
        annotations: { ...datadogAnnotation },
        namespace: namespace,
        labels: labels,
      },
      spec: {
        terminationGracePeriodSeconds: 5,
        containers: [
          {
            name: `${name}-${worker.name}`,
            image: imageName,
            env: [...secretEnvs],
            workingDir: config.isLocal ? `/app/coinstacks/${asset}/ingester` : undefined,
            command: config.isLocal
              ? localCommand
              : ['sh', '-c', `node --max-old-space-size=1024 dist/${worker.path}.js`],
            volumeMounts: volumeMounts,
            resources: {
              limits: {
                cpu: config.isLocal ? '0.5' : '1',
                memory: config.isLocal ? '512M' : '1G',
              },
            },
            readinessProbe: {
              exec: { command: ['cat', '/tmp/ready'] },
              initialDelaySeconds: 5,
              periodSeconds: config.isLocal ? 10 : 5,
              failureThreshold: config.isLocal ? 3 : 1,
              successThreshold: 1,
            },
            livenessProbe: {
              exec: { command: ['cat', '/tmp/ready'] },
              initialDelaySeconds: 10,
              periodSeconds: config.isLocal ? 10 : 1,
              failureThreshold: config.isLocal ? 3 : 1,
              successThreshold: 1,
            },
          },
        ],
        volumes: volumes,
      },
    }

    return new k8s.apps.v1.Deployment(
      `${name}-${worker.name}`,
      {
        metadata: {
          namespace: namespace,
          annotations: worker.name.includes('socket') ? { 'pulumi.com/skipAwait': 'true' } : undefined,
        },
        spec: {
          selector: { matchLabels: labels },
          replicas: worker.replicas,
          template: podSpec,
        },
      },
      {
        provider,
        dependsOn: output(deployDependencies).apply((dependencies) => [...dependencies, topology]),
      }
    )
  })
}
