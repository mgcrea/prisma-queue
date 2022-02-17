import {prisma, waitFor} from 'test/utils';
import {createQueue, PrismaQueue} from 'src/index';
import {debug} from 'src/utils';
import {PrismaClient} from '@prisma/client';
import {PrismaJob} from 'src/PrismaJob';

type JobPayload = {email: string};
type JobResult = {code: string};

const pollInterval = 1000;
const pollWait = pollInterval + 1000;
const createEmailQueue = () => createQueue<JobPayload, JobResult>({prisma, pollInterval});

// beforeAll(() => {});
describe('PrismaQueue', () => {
  it('should properly create a queue', () => {
    const emailQueue = createEmailQueue();
    expect(emailQueue).toBeDefined();
    expect(Object.keys(emailQueue)).toMatchSnapshot();
  });
  describe('enqueue', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(() => {
      queue = createEmailQueue();
    });
    it('should properly enqueue a job', async () => {
      const job = await queue.enqueue({email: 'foo@bar.com'});
      expect(job).toBeInstanceOf(PrismaJob);
      expect(Object.keys(job)).toMatchSnapshot();
      const record = await job.fetch();
      expect(record?.payload).toEqual({email: 'foo@bar.com'});
      expect(record?.runAt).toBeInstanceOf(Date);
    });
  });

  describe('schedule', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
    });
    it('should properly schedule a recurring job', async () => {
      const job = await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'foo@bar.com'});
      expect(job).toBeInstanceOf(PrismaJob);
      const record = await job.fetch();
      expect(record?.runAt.getHours()).toEqual(5);
      expect(record?.runAt.getMinutes()).toEqual(5);
    });
    it('should properly upsert a recurring job', async () => {
      await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'foo@bar.com'});
      await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'baz@bar.com'});
      const jobs = await prisma.queueJob.findMany({where: {key: 'email-schedule'}});
      expect(jobs.length).toEqual(1);
      expect(jobs[0].payload).toEqual({email: 'baz@bar.com'});
    });
    it('should properly upsert a recurring job with another schedule', async () => {
      await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'foo@bar.com'});
      await queue.schedule({key: 'email-schedule', cron: '0 5 * * *'}, {email: 'foo@bar.com'});
      const jobs = await prisma.queueJob.findMany({where: {key: 'email-schedule'}});
      expect(jobs.length).toEqual(1);
      expect(jobs[0].runAt.getMinutes()).toEqual(0);
    });
  });

  describe('dequeue', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
      const promise = queue.start();
      expect(promise instanceof Promise);
    });
    it('should properly dequeue a successful job', async () => {
      queue.worker = jest.fn(async (_job) => {
        return {code: '200'};
      });
      const result = await queue.enqueue({email: 'foo@bar.com'});
      await waitFor(pollInterval);
      expect(queue.worker).toBeCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), expect.any(PrismaClient));
      expect(result).toBeDefined();
      expect(Object.keys(result)).toMatchSnapshot();
      // @TODO check db
    });
    it('should properly dequeue a failed job', async () => {
      queue.worker = jest.fn(async (_job) => {
        throw new Error('failed');
      });
      const result = await queue.enqueue({email: 'foo@bar.com'});
      await waitFor(pollInterval);
      expect(queue.worker).toBeCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), expect.any(PrismaClient));
      expect(result).toBeDefined();
      expect(Object.keys(result)).toMatchSnapshot();
      // @TODO check db
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe('Job.progress()', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
      const promise = queue.start();
      expect(promise instanceof Promise);
    });
    it('should properly update job progress', async () => {
      queue.worker = jest.fn(async (job) => {
        debug('working...', job.id, job.payload);
        await job.progress(50);
        throw new Error('failed');
      });
      const job = await queue.enqueue({email: 'foo@bar.com'});
      await waitFor(pollWait);
      const record = await job.fetch();
      expect(record?.progress).toEqual(50);
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe('priority', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
    });
    it('should properly prioritize a job with a lower priority', async () => {
      queue.worker = jest.fn(async (_job) => {
        return {code: '200'};
      });
      await queue.enqueue({email: 'foo@bar.com'});
      await queue.enqueue({email: 'baz@bar.com'}, {priority: -1});
      queue.start();
      await waitFor(pollInterval + 25);
      expect(queue.worker).toBeCalledTimes(2);
      expect(queue.worker).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          record: expect.objectContaining({payload: {email: 'baz@bar.com'}}),
        }),
        expect.any(PrismaClient)
      );
      expect(queue.worker).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          record: expect.objectContaining({payload: {email: 'foo@bar.com'}}),
        }),
        expect.any(PrismaClient)
      );
    });
    afterAll(() => {
      queue.stop();
    });
  });
});

/*

beforeAll(async () => {
  // create product categories
  await prisma.category.createMany({
    data: [{name: 'Wand'}, {name: 'Broomstick'}],
  });

  console.log('✨ 2 categories successfully created!');

  // create products
  await prisma.product.createMany({
    data: [
      {
        name: 'Holly, 11", phoenix feather',
        description: 'Harry Potters wand',
        price: 100,
        sku: 1,
        categoryId: 1,
      },
      {
        name: 'Nimbus 2000',
        description: 'Harry Potters broom',
        price: 500,
        sku: 2,
        categoryId: 2,
      },
    ],
  });

  console.log('✨ 2 products successfully created!');

  // create the customer
  await prisma.customer.create({
    data: {
      name: 'Harry Potter',
      email: 'harry@hogwarts.io',
      address: '4 Privet Drive',
    },
  });

  console.log('✨ 1 customer successfully created!');
});

afterAll(async () => {
  const deleteOrderDetails = prisma.orderDetails.deleteMany();
  const deleteProduct = prisma.product.deleteMany();
  const deleteCategory = prisma.category.deleteMany();
  const deleteCustomerOrder = prisma.customerOrder.deleteMany();
  const deleteCustomer = prisma.customer.deleteMany();

  await prisma.$transaction([deleteOrderDetails, deleteProduct, deleteCategory, deleteCustomerOrder, deleteCustomer]);

  await prisma.$disconnect();
});

it('should create 1 new customer with 1 order', async () => {
  // The new customers details
  const customer: Customer = {
    id: 2,
    name: 'Hermione Granger',
    email: 'hermione@hogwarts.io',
    address: '2 Hampstead Heath',
  };
  // The new orders details
  const order: OrderInput = {
    customer,
    productId: 1,
    quantity: 1,
  };

  // Create the order and customer
  await createOrder(order);

  // Check if the new customer was created by filtering on unique email field
  const newCustomer = await prisma.customer.findUnique({
    where: {
      email: customer.email,
    },
  });

  // Check if the new order was created by filtering on unique email field of the customer
  const newOrder = await prisma.customerOrder.findFirst({
    where: {
      customer: {
        email: customer.email,
      },
    },
  });

  // Expect the new customer to have been created and match the input
  expect(newCustomer).toEqual(customer);
  // Expect the new order to have been created and contain the new customer
  expect(newOrder).toHaveProperty('customerId', 2);
});

it('should create 1 order with an existing customer', async () => {
  // The existing customers email
  const customer: Customer = {
    email: 'harry@hogwarts.io',
  };
  // The new orders details
  const order: OrderInput = {
    customer,
    productId: 1,
    quantity: 1,
  };

  // Create the order and connect the existing customer
  await createOrder(order);

  // Check if the new order was created by filtering on unique email field of the customer
  const newOrder = await prisma.customerOrder.findFirst({
    where: {
      customer: {
        email: customer.email,
      },
    },
  });

  // Expect the new order to have been created and contain the existing customer with an id of 1 (Harry Potter from the seed script)
  expect(newOrder).toHaveProperty('customerId', 1);
});

it("should show 'Out of stock' message if productId doesn't exit", async () => {
  // The existing customers email
  const customer: Customer = {
    email: 'harry@hogwarts.io',
  };
  // The new orders details
  const order: OrderInput = {
    customer,
    productId: 3,
    quantity: 1,
  };

  // The productId supplied doesn't exit so the function should return an "Out of stock" message
  await expect(createOrder(order)).resolves.toEqual(new Error('Out of stock'));
});

*/
