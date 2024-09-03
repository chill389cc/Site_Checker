import nodemailer, { type Transporter } from 'nodemailer'
import { EventEmitter } from 'events'
import pinoLogger from 'pino'
import { promisify } from 'node:util'
import { STATUS, Site } from './types'

const logger = pinoLogger({
        level: process.env.LOG_LEVEL ?? 'info',
        transport: {
            target: 'pino-pretty'
        },
    })
const eventEmitter = new EventEmitter();

// TODO Make these configurable environment variables
const alertMailOptions = {
    from: process.env.MAIL_USERNAME,
    to: process.env.MAIL_USERNAME
}

/**
 * Number of fails that we should permit when checking before giving up
 */
const ATTEMPTS_BEFORE_GIVING_UP = 3

const MINUTES = 1000 * 60
const HOURS = 1000 * 60 * 60

const sites: Site[] = [
    {
        name: 'LibTheatreRoom',
        url: "https://byu.libcal.com/reserve/mediaviewroomss",
        textMatch: "This resource is temporarily unavailable.",
        interval: 5 * MINUTES,
        msgCooldown: 4 * HOURS,
        status: STATUS.READY
    }
]

const failedAttempts: Record<string, number> = {} 

async function main() {
    verifyExistenceOfImportantEnvVars()
    const transporter = createTransport()
    await verifyTransport(transporter)

    async function sendAlert(subject: string, body: string) {
        logger.debug(`Sending message with subject "${subject}"...`)
        await transporter.sendMail({
            ...alertMailOptions,
            subject,
            text: body
        })
        logger.debug(`Message with "${subject}" successfully sent.`)
    }

    async function checkErrorHandler(site: Site, e: Error | string, msg: string) {
        logger.error(msg)
        logger.error(e)
        failedAttempts[site.name]++
        // On the first failure, warn by email
        if (failedAttempts[site.name] === 1) {
            sendAlert(`Content Check for ${site.name} failed (once)`,
                `The attempt to check the contents of ${site.url} failed for this reason: ${e.toString()}.\n\n\nWe'll try again in ${site.msgCooldown} hours.`)
        } else if (failedAttempts[site.name] > ATTEMPTS_BEFORE_GIVING_UP) {
            // After a number of failures, warn and then stop trying.
            sendAlert(`Content Check for ${site.name} failed ${ATTEMPTS_BEFORE_GIVING_UP} times, we're giving up.`,
                `The attempt to check the contents of ${site.url} failed for this reason: ${e.toString()}.\n\n\nSince we've already tried again ${ATTEMPTS_BEFORE_GIVING_UP} times, we're going to stop checking this one until you restart the server.`)
            return STATUS.GAVE_UP
        }
        return STATUS.COOLDOWN
    }

    async function check(site: Site): Promise<STATUS> {
        logger.debug(`Making web request to "${site.url}"...`)
        let res: Response | null = null
        try {
            res = await fetch(site.url)
        } catch (e) {
            return checkErrorHandler(site, e as Error, `Failed to make fetch call when making check on ${site.name}, will try again after cooldown. Here is the error:\n`)
        }
        
        logger.debug(`Web request to "${site.url}" complete, now parsing...`)
        if (res.status !== 200) {
            return checkErrorHandler(site, `Status code on HTTP request was ${res.status}, not 200`, `Bad status code (${res.status}) on request to "${site.url}", sending error email.`)
        }
        let html: string | null = null
        try {
            html = await res.text()
        } catch (e) {
            return checkErrorHandler(site, e as Error, `Failed to parse HTML from response after fetching url for ${site.name} (${site.url}). We'll skip the check for now and try again after a cooldown. Here is the error:\n`)
        }
        const hasMatch = html.includes(site.textMatch)
        if (!hasMatch) {
            logger.warn(`Failed to find text match for ${site.name} check, sending notification now.`)
            sendAlert(`Contents have changed for ${site.name}!`,
                `After a recent check of ${site.url}, we have no longer found the text "${site.textMatch}". Visit it <a href="${site.url}" target="_blank">here</a>.`)
            return STATUS.COOLDOWN
        }
        logger.info(`Found text match for ${site.name} check, all is as expected.`)
        return STATUS.WAIT
    }

    async function handler(site: Site) {
        logger.info(`Check initiated after timeout for ${site.name}, beginning check.`)
        const status: STATUS = await check(site)

        const checkCallback = () => {
            logger.debug(`Timeout reached for ${site.name}, emitting event now for handler...`)
            eventEmitter.emit(site.name)
        }
        let delay
        switch (status) {
            case STATUS.COOLDOWN:
                delay = site.msgCooldown
                logger.debug(`Got status "cooldown" from check, initiating timeout of ${delay / HOURS} hours (${delay}ms)...`)
                setTimeout(checkCallback, delay)
                break
            case STATUS.WAIT:
                delay = site.interval
                logger.debug(`Got status "wait" from check, initiating timeout of ${delay / MINUTES} minutes (${delay}ms)...`)
                setTimeout(checkCallback, delay)
                break
            case STATUS.READY:
                logger.debug(`Got status "ready" from check, calling callback immediately.`)
                checkCallback()
                break
            case STATUS.GAVE_UP:
                logger.debug(`Got status "gave_up" from check, doing nothing (setting no future callbacks).`)
                break
            default:
                logger.error(`Default case reached in handler switch on ${site.name} with status ${status}, exiting...`)
                process.exit(1);
        }
    }

    logger.debug('Iterating over all sites to start the checking...')
    for (const site of sites) {
        logger.info(`Setting event listener for the ${site.name} check...`)
        const callback = async () => { await handler(site) }
        eventEmitter.on(site.name, callback)
        failedAttempts[site.name] = 0
        logger.info(`Emitting initial event for ${site.name}...`) 
        eventEmitter.emit(site.name)
    }
}
main()

// Verify that the mail sender has access to send messages
async function verifyTransport(transporter: Transporter): Promise<void> {
    logger.info('Verifying that email transport agent has authorization to send emails...')
    try {
        const asyncVerify = promisify(transporter.verify)
        await asyncVerify()
        logger.info('Email transport is authorized, ready to send emails!')
    } catch (e) {
        logger.error('Email transport authorization failed with this error: ');
        logger.error(e)
        process.exit(1)
    }
}

// Set up the mail sender
function createTransport(): Transporter {
    logger.info('Initializing email transport agent...')
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.MAIL_USERNAME,
            pass: process.env.MAIL_APP_PASSWORD
        }
    })
    logger.info('Email transport agent successfully initialized.')
    return transporter
}

function verifyExistenceOfImportantEnvVars(): void {
    if (process.env.MAIL_USERNAME == null || process.env.MAIL_APP_PASSWORD == null) {
        logger.error('Error, failed to find some email authentication environment variables.' +
            'Please make sure MAIL_USERNAME and MAIL_APP_PASSWORD are set as environment variables before running.')
        process.exit(1);
    }
}