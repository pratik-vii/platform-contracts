"use strict";

let AgentFactory = artifacts.require("AgentFactory");
let Agent = artifacts.require("Agent");
let Registry = artifacts.require("Registry");
let Job = artifacts.require("Job");
let Contract = require("truffle-contract");
let TokenJson = require("singularitynet-token-contracts/SingularityNetToken.json");
let Token = Contract(TokenJson);
let { STRINGS, AGENT_STATE, JOB_STATE, HELPERS : { signAddress, hex2ascii, trimByChar }} = require("./util.js");

Token.setProvider(web3.currentProvider);

// use triple equals for all equality and inequality checks
assert.equal    = assert.strictEqual;
assert.notEqual = assert.notStrictEqual;

contract("Old Registry Test", async (accounts) => {
    const testConstants = Object.freeze({
        CreatorAccount  : accounts[1], // creator of agent
        ConsumerAccount : accounts[0], // consumer of agent
        AgentName       : "Mr. Smith", // name of the agent
        AgentPrice      : 8          , // price that agent demands for services
        AgentUrl        : "http://fake.url", // agent's hosted service url
    });

    const testState = Object.seal({
        // blockchain info
        TokenAddress         : null,
        AgentFactoryInstance : null,
        TokenInstance        : null,
        AgentInstance        : null,
        RegistryInstance     : null,
        JobInstance          : null,
        // signature outputs
        Signature : {
            v: null,
            r: null,
            s: null
        }
    });

    before(async () => {
        testState.AgentFactoryInstance = await AgentFactory.deployed();
        testState.TokenAddress         = await testState.AgentFactoryInstance.token.call();

        testState.TokenInstance = Token.at(testState.TokenAddress);
    });

    it(`Creates agent with owner ${testConstants.CreatorAccount}, price ${testConstants.AgentPrice}, and url ${testConstants.AgentUrl}`, async () => {
        const createAgentResult = await testState.AgentFactoryInstance.createAgent(testConstants.AgentPrice, testConstants.AgentUrl, {from: testConstants.CreatorAccount});
        testState.AgentInstance = Agent.at(createAgentResult.logs[0].args.agent);

        const state        = (await testState.AgentInstance.state.call()).toNumber();
        const owner        = await testState.AgentInstance.owner.call();
        const currentPrice = (await testState.AgentInstance.currentPrice.call()).toNumber();
        const endpoint     = await testState.AgentInstance.endpoint.call();

        assert.equal(AGENT_STATE.ENABLED         , state       , "Agent state should be ENABLED");
        assert.equal(testConstants.CreatorAccount, owner       , "Agent's owner was not saved correctly");
        assert.equal(testConstants.AgentPrice    , currentPrice, "Agent price was not saved correctly");
        assert.equal(testConstants.AgentUrl      , endpoint    , "Agent endpoint was not saved correctly");
    });

    it(`Registers agent with name ${testConstants.AgentName}`, async () => {
        testState.RegistryInstance = await Registry.deployed();
        await testState.RegistryInstance.createRecord(testConstants.AgentName, testState.AgentInstance.address, {from: testConstants.CreatorAccount});

        const agents       = await testState.RegistryInstance.listRecords.call();
        const agentName    = trimByChar(web3.toAscii(agents[0][0]),'\0');
        const agentAddress = trimByChar(agents[1][0], '\0');

        assert.equal(1                              , agents[0].length, `Registry does not list exactly 1 agent`);
        assert.equal(testConstants.AgentName        , agentName       , `Registry does not list Agent ${testConstants.AgentName}`)
        assert.equal(testState.AgentInstance.address, agentAddress    , "Registry does not list the correct agent address");
    });

    it(`Creates job with consumer account ${testConstants.ConsumerAccount}`, async () => {
        const createJobResult = await testState.AgentInstance.createJob({from: testConstants.ConsumerAccount});
        testState.JobInstance = Job.at(createJobResult.logs[0].args.job);

        const jobPrice = (await testState.JobInstance.jobPrice.call()).toNumber();
        const consumer = await testState.JobInstance.consumer.call();
        const agent    = await testState.JobInstance.agent.call();
        const state    = (await testState.JobInstance.state.call()).toNumber();

        assert.equal(testConstants.AgentPrice       , jobPrice, "Job price was not copied correctly from the AgentInstance");
        assert.equal(testConstants.ConsumerAccount  , consumer, "Job consumer was not saved correctly");
        assert.equal(testState.AgentInstance.address, agent   , "Agent address is mismatched between JobInstance and AgentInstance");
        assert.equal(JOB_STATE.PENDING              , state   , "Job state should be PENDING");
    });

    it(`Funds job by consumer ${testConstants.ConsumerAccount} with ${testConstants.AgentPrice} AGI`, async () => {
        await testState.TokenInstance.approve(testState.JobInstance.address, testConstants.AgentPrice, {from: testConstants.ConsumerAccount});
        const fundJobResult = await testState.JobInstance.fundJob({from: testConstants.ConsumerAccount});
        const balance       = (await testState.TokenInstance.balanceOf.call(testState.JobInstance.address)).toNumber();
        const state         = (await testState.JobInstance.state.call()).toNumber();

        assert.equal(testConstants.AgentPrice, balance, `Job was not funded with ${testConstants.AgentPrice} AGI`);
        assert.equal(JOB_STATE.FUNDED        , state  , "Job state should be FUNDED");
    });

    it(`Signs job address by consumer ${testConstants.ConsumerAccount} and validate signature by owner ${testConstants.CreatorAccount}`, async () => {
        [testState.Signature.v, testState.Signature.r, testState.Signature.s] = signAddress(testState.JobInstance.address, testConstants.ConsumerAccount);

        const validated = await testState.AgentInstance.validateJobInvocation(testState.JobInstance.address
            , testState.Signature.v, testState.Signature.r, testState.Signature.s);
        assert.equal(true, validated, "Signature should be validated");
    });

    it(`Completes job by owner ${testConstants.CreatorAccount} and checks contract states`, async () => {
        // complete the job
        await testState.AgentInstance.completeJob(testState.JobInstance.address
            , testState.Signature.v, testState.Signature.r, testState.Signature.s
            , {from: testConstants.CreatorAccount});

        // verify Job-side state
        const jobPrice    = (await testState.JobInstance.jobPrice.call()).toNumber();
        const jobConsumer = await testState.JobInstance.consumer.call();
        const jobAgent    = await testState.JobInstance.agent.call();
        const jobState    = (await testState.JobInstance.state.call()).toNumber();

        assert.equal(testConstants.AgentPrice       , jobPrice   , "Job price was changed");
        assert.equal(testConstants.ConsumerAccount  , jobConsumer, "Job consumer account was changed");
        assert.equal(testState.AgentInstance.address, jobAgent   , "Job's reference to AgentInstance was changed");
        assert.equal(JOB_STATE.COMPLETED            , jobState   , "Job should be in COMPLETED state");

        // verify Agent-side state
        const agentOwner        = await testState.AgentInstance.owner.call();
        const agentPrice        = (await testState.AgentInstance.currentPrice.call()).toNumber();
        const agentOwnerBalance = (await testState.TokenInstance.balanceOf.call(agentOwner)).toNumber();

        assert.equal(testConstants.CreatorAccount, agentOwner       , "Agent owner was changed");
        assert.equal(testConstants.AgentPrice    , agentPrice       , "AgentPrice was changed");
        assert.equal(testConstants.AgentPrice    , agentOwnerBalance, `Agent owner does not have ${testConstants.AgentPrice} AGI`);

    });

    it(`Deprecates the Agent record in the registry`, async () => {
        await testState.RegistryInstance.deprecateRecord(testConstants.AgentName, {from: testConstants.CreatorAccount});
        let agents = await testState.RegistryInstance.listRecords.call();
        assert.equal(STRINGS.NULL_ADDRESS, agents[1][0]);
    });
});
