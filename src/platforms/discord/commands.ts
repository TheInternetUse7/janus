
import { SlashCommandBuilder } from 'discord.js';

export const bridgeCommand = new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('Manage bridge connections')
    .addSubcommand(subcommand =>
        subcommand
            .setName('create')
            .setDescription('Create a new bridge to a Fluxer channel')
            .addStringOption(option =>
                option.setName('fluxer_channel_id')
                    .setDescription('The ID of the Fluxer channel')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('list')
            .setDescription('List all active bridges'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('delete')
            .setDescription('Delete a bridge')
            .addStringOption(option =>
                option.setName('bridge_id')
                    .setDescription('The ID of the bridge to delete')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('toggle')
            .setDescription('Toggle a bridge on or off')
            .addStringOption(option =>
                option.setName('bridge_id')
                    .setDescription('The ID of the bridge to toggle')
                    .setRequired(true))
            .addBooleanOption(option =>
                option.setName('active')
                    .setDescription('Whether the bridge should be active')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('repair')
            .setDescription('Repair webhook for a bridge')
            .addStringOption(option =>
                option.setName('bridge_id')
                    .setDescription('The ID of the bridge to repair')
                    .setRequired(true)));
