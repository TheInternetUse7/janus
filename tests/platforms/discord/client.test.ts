import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClientLogin,
  mockRestPut,
  mockCreateBridge,
  mockDeleteBridge,
} = vi.hoisted(() => ({
  mockClientLogin: vi.fn(),
  mockRestPut: vi.fn(),
  mockCreateBridge: vi.fn(),
  mockDeleteBridge: vi.fn(),
}));

vi.mock('../../../src/lib/bridge', () => ({
  bridgeService: {
    createBridge: mockCreateBridge,
    deleteBridge: mockDeleteBridge,
    listBridges: vi.fn(),
    toggleBridge: vi.fn(),
    repairBridgeWebhook: vi.fn(),
  },
}));

vi.mock('../../../src/config', () => ({
  config: {
    discord: {
      token: 'discord-token',
    },
  },
}));

vi.mock('discord.js', async () => {
  class MockClient {
    public handlers = new Map<string | symbol, (...args: any[]) => any>();
    public guilds = { cache: { size: 1 } };
    public user = { id: 'bot-user' };
    public channels = { fetch: vi.fn() };

    constructor(_options: unknown) {}

    once(event: string | symbol, handler: (...args: any[]) => any) {
      this.handlers.set(event, handler);
      return this;
    }

    on(event: string | symbol, handler: (...args: any[]) => any) {
      this.handlers.set(event, handler);
      return this;
    }

    async login(token: string) {
      return mockClientLogin(token);
    }

    destroy() {}

    emit(event: string | symbol, ...args: any[]) {
      return this.handlers.get(event)?.(...args);
    }

    async fetchWebhook() {
      return null;
    }
  }

  class MockREST {
    setToken() {
      return this;
    }

    async put(...args: any[]) {
      return mockRestPut(...args);
    }
  }

  class MockSlashCommandBuilder {
    setName() {
      return this;
    }
    setDescription() {
      return this;
    }
    addSubcommand(factory: (subcommand: MockSlashCommandBuilder) => unknown) {
      factory(new MockSlashCommandBuilder());
      return this;
    }
    addStringOption(factory: (option: MockSlashCommandBuilder) => unknown) {
      factory(new MockSlashCommandBuilder());
      return this;
    }
    addBooleanOption(factory: (option: MockSlashCommandBuilder) => unknown) {
      factory(new MockSlashCommandBuilder());
      return this;
    }
    setRequired() {
      return this;
    }
    toJSON() {
      return {};
    }
  }

  return {
    AttachmentBuilder: class {},
    Client: MockClient,
    Events: {
      ClientReady: 'ready',
      MessageCreate: 'messageCreate',
      MessageUpdate: 'messageUpdate',
      MessageDelete: 'messageDelete',
      GuildCreate: 'guildCreate',
      GuildDelete: 'guildDelete',
      Error: 'error',
      InteractionCreate: 'interactionCreate',
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
    },
    MessageFlags: {
      Ephemeral: 64,
    },
    NewsChannel: class {},
    REST: MockREST,
    Routes: {
      applicationCommands: vi.fn(() => '/commands'),
    },
    SlashCommandBuilder: MockSlashCommandBuilder,
    TextChannel: class {},
  };
});

import { DiscordClient } from '../../../src/platforms/discord/client';

function makeInteraction() {
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'bridge',
    channelId: 'discord-channel-1',
    guildId: 'discord-guild-1',
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => 'create',
      getString: () => 'fluxer-channel-1',
    },
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn(),
    followUp: vi.fn(),
  };
  return interaction;
}

let interaction: ReturnType<typeof makeInteraction>;

describe('discord client slash commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    interaction = makeInteraction();
  });

  it('defers bridge creation responses before long-running work', async () => {
    mockCreateBridge.mockResolvedValueOnce({ id: 'bridge-1' });

    const client = new DiscordClient();
    await (client.getClient() as any).emit('interactionCreate', interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mockCreateBridge).toHaveBeenCalledWith(
      'discord-channel-1',
      'fluxer-channel-1',
      'discord-guild-1'
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      'Bridge created between this channel and Fluxer channel fluxer-channel-1'
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
